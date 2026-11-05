// RemoteDesk – Host-App (läuft auf dem Computer, der gesteuert wird)
const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, clipboard, shell,
  systemPreferences, Tray, Menu, nativeImage, nativeTheme, Notification, session: electronSession,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const https = require('https');
const { resolveKey, resolveName } = require('./keymap');

let nut = null;
try {
  nut = require('@nut-tree-fork/nut-js');
  nut.mouse.config.autoDelayMs = 0;
  nut.mouse.config.mouseSpeed = 100000;
  nut.keyboard.config.autoDelayMs = 0;
} catch (err) {
  console.error('nut-js konnte nicht geladen werden – Steuerung deaktiviert:', err.message);
}

const isMac = process.platform === 'darwin';
const VIEWER_URL = 'https://laudisa01.github.io/remote-desk/';
let win = null;
let tray = null;
let quitting = false;
let selectedDisplay = null;
let sessionActive = false;

// Nur eine Instanz (sonst wäre der feste Code doppelt belegt)
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

// ---------- Konfiguration ----------
const configPath = () => path.join(app.getPath('userData'), 'config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
function loadConfig() {
  const cfg = {
    requireConfirm: false,
    scrollPixelsPerStep: isMac ? 10 : 100,
    displayId: null,
    audio: true,
    notify: true,
    lockOnEnd: false,
    multiView: true,
    ...readConfig(),
  };
  // Fester 9-stelliger Computer-Code – wird einmal erzeugt und bleibt immer gleich
  if (!cfg.deviceId) {
    cfg.deviceId = String(crypto.randomInt(100000000, 1000000000));
    writeConfig(cfg);
  }
  return cfg;
}
function publicConfig() {
  const c = loadConfig();
  return {
    deviceId: c.deviceId,
    hasPin: !!c.pinHash,
    requireConfirm: !!c.requireConfirm,
    autostart: app.getLoginItemSettings().openAtLogin,
    displayId: c.displayId,
    audio: c.audio !== false,
    notify: c.notify !== false,
    lockOnEnd: !!c.lockOnEnd,
    multiView: c.multiView !== false,
    version: app.getVersion(),
    viewerUrl: VIEWER_URL,
    computerName: os.hostname().replace(/\.local$/, ''),
  };
}

// ---------- PIN ----------
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
let fails = []; // Zeitstempel fehlgeschlagener Versuche

ipcMain.handle('pin:set', (_e, { pin, oldPin }) => {
  const cfg = loadConfig();
  if (!/^\d{6,12}$/.test(String(pin))) return { ok: false, msg: 'Die PIN muss aus 6 bis 12 Ziffern bestehen.' };
  if (cfg.pinHash && hashPin(oldPin || '', cfg.pinSalt) !== cfg.pinHash) return { ok: false, msg: 'Die bisherige PIN ist falsch.' };
  cfg.pinSalt = crypto.randomBytes(16).toString('hex');
  cfg.pinHash = hashPin(pin, cfg.pinSalt);
  writeConfig(cfg);
  return { ok: true };
});

let oncePin = null; // { pin, expires }
ipcMain.handle('once:create', () => {
  oncePin = { pin: String(crypto.randomInt(0, 1000000)).padStart(6, '0'), expires: Date.now() + 10 * 60 * 1000 };
  return oncePin;
});
ipcMain.handle('once:clear', () => { oncePin = null; });

ipcMain.handle('pin:verify', async (_e, pin) => {
  const cfg = loadConfig();
  const now = Date.now();
  fails = fails.filter((t) => now - t < LOCK_MS);
  if (fails.length >= MAX_FAILS) {
    const mins = Math.ceil((fails[0] + LOCK_MS - now) / 60000);
    return { ok: false, msg: `Zu viele falsche PINs. Gesperrt für ${mins} Min.` };
  }
  await new Promise((r) => setTimeout(r, 800)); // bremst Durchprobieren
  // Einmal-PIN (Hilfe-Zugang): gilt 10 Minuten und nur für eine Verbindung
  if (oncePin && now < oncePin.expires && /^\d{6}$/.test(String(pin || ''))) {
    const x = Buffer.from(String(pin)), y = Buffer.from(oncePin.pin);
    if (x.length === y.length && crypto.timingSafeEqual(x, y)) {
      oncePin = null;
      fails = [];
      if (win) win.webContents.send('once:used');
      return { ok: true, once: true };
    }
  }
  if (!cfg.pinHash) return { ok: false, msg: 'Auf diesem Computer ist noch keine PIN eingerichtet.' };
  const a = Buffer.from(hashPin(pin || '', cfg.pinSalt), 'hex');
  const b = Buffer.from(cfg.pinHash, 'hex');
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    fails = [];
    return { ok: true };
  }
  fails.push(now);
  const left = MAX_FAILS - fails.length;
  return { ok: false, msg: left > 0 ? `Falsche PIN. Noch ${left} Versuch(e).` : 'Falsche PIN. Zugang für 15 Min. gesperrt.' };
});

// ---------- Fenster & Tray ----------
function createWindow(hidden) {
  win = new BrowserWindow({
    width: 460,
    height: 700,
    show: !hidden,
    title: 'RemoteDesk',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f5f5f7',
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // Übertragung soll auch im Hintergrund flüssig bleiben
    },
  });
  win.setMenuBarVisibility(false);
  // Systemton: getDisplayMedia liefert den Ton des Computers ("loopback")
  electronSession.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const [src] = await desktopCapturer.getSources({ types: ['screen'] });
      cb({ video: src, audio: 'loopback' });
    } catch { cb({}); }
  });
  win.loadFile('renderer.html');
  // Schließen = in den Hintergrund (bleibt erreichbar). Beenden über das Tray-Menü.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

function trayIcon(active) {
  // 16×16 Symbol ohne Bilddatei: Bildschirm-Rahmen, aktiv = Punkt in der Mitte
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const frame = y >= 2 && y <= 11 && x >= 1 && x <= 14 && (y === 2 || y === 11 || x === 1 || x === 14);
      const stand = (y === 13 && x >= 5 && x <= 10) || (y === 12 && x >= 7 && x <= 8);
      const dot = active && (x - 7.5) ** 2 + (y - 6.5) ** 2 <= 5;
      if (frame || stand || dot) {
        const i = (y * size + x) * 4;
        const v = isMac ? 0 : 255; // Mac: Template (schwarz), Windows: weiß
        buf[i] = buf[i + 1] = buf[i + 2] = v;
        buf[i + 3] = 255;
      }
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size });
  if (isMac) img.setTemplateImage(true);
  return img;
}

function updateTray() {
  if (!tray) return;
  tray.setImage(trayIcon(sessionActive));
  tray.setToolTip(sessionActive ? 'RemoteDesk – wird ferngesteuert' : 'RemoteDesk – bereit');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: sessionActive ? '● Wird ferngesteuert' : 'Bereit für Fernzugriff', enabled: false },
    { label: `Code: ${loadConfig().deviceId.replace(/(\d{3})(?=\d)/g, '$1 ')}`, enabled: false },
    { type: 'separator' },
    ...(sessionActive ? [{ label: 'Verbindung trennen', click: () => win.webContents.send('session:stop') }] : []),
    { label: 'RemoteDesk öffnen', click: showWindow },
    { label: 'Beenden', click: () => { quitting = true; app.quit(); } },
  ]));
}

app.whenReady().then(() => {
  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden;
  createWindow(hidden);
  tray = new Tray(trayIcon(false));
  tray.on('click', () => { if (!isMac) showWindow(); });
  updateTray();
});
app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; });

// ---------- IPC: Allgemein ----------
ipcMain.handle('config:get', () => publicConfig());
ipcMain.handle('config:set', (_e, patch) => {
  const cfg = loadConfig();
  if ('requireConfirm' in patch) cfg.requireConfirm = !!patch.requireConfirm;
  if ('displayId' in patch) cfg.displayId = patch.displayId;
  for (const k of ['audio', 'notify', 'lockOnEnd', 'multiView']) if (k in patch) cfg[k] = !!patch[k];
  writeConfig(cfg);
  if ('autostart' in patch) {
    app.setLoginItemSettings({ openAtLogin: !!patch.autostart, openAsHidden: true, args: ['--hidden'] });
  }
  return publicConfig();
});
ipcMain.handle('open:viewer', () => shell.openExternal(VIEWER_URL));

ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } });
  const displays = screen.getAllDisplays();
  return sources.map((s, i) => {
    const d = displays.find((x) => String(x.id) === String(s.display_id)) || displays[i] || screen.getPrimaryDisplay();
    return {
      id: s.id,
      name: s.name,
      displayId: d.id,
      primary: d.id === screen.getPrimaryDisplay().id,
      bounds: d.bounds,
      scale: d.scaleFactor,
      size: `${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}`,
      thumb: s.thumbnail.toDataURL(),
    };
  });
});

ipcMain.handle('display:select', (_e, displayId) => {
  if (displayId === 'all') {
    // Alle Bildschirme: gemeinsame Fläche aller Monitore
    const ds = screen.getAllDisplays();
    const x1 = Math.min(...ds.map((d) => d.bounds.x)), y1 = Math.min(...ds.map((d) => d.bounds.y));
    const x2 = Math.max(...ds.map((d) => d.bounds.x + d.bounds.width)), y2 = Math.max(...ds.map((d) => d.bounds.y + d.bounds.height));
    selectedDisplay = { bounds: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, scaleFactor: 1, size: { width: x2 - x1, height: y2 - y1 } };
    return { width: x2 - x1, height: y2 - y1, bounds: selectedDisplay.bounds };
  }
  selectedDisplay = screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
  return {
    width: Math.round(selectedDisplay.size.width * selectedDisplay.scaleFactor),
    height: Math.round(selectedDisplay.size.height * selectedDisplay.scaleFactor),
  };
});

ipcMain.handle('access:confirm', async (_e, kind) => {
  showWindow();
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Zugriff erlauben', 'Ablehnen'],
    defaultId: 1,
    cancelId: 1,
    title: 'Fernzugriff',
    message: 'Jemand möchte auf diesen Computer zugreifen.',
    detail: kind === 'once'
      ? 'Die Einmal-PIN (Hilfe-Zugang) wurde eingegeben. Die Person kann deinen Bildschirm sehen und Maus und Tastatur steuern.'
      : kind === 'view'
        ? 'Die richtige PIN wurde eingegeben. Die Person kann deinen Bildschirm ansehen (nur zusehen, nicht steuern).'
        : 'Die richtige PIN wurde eingegeben. Die Person kann deinen Bildschirm sehen und Maus und Tastatur steuern.',
  });
  return response === 0;
});

ipcMain.handle('permissions:check', () => {
  if (!isMac) return { screen: 'granted', accessibility: true, input: !!nut };
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    input: !!nut,
  };
});
ipcMain.handle('permissions:request', (_e, which) => {
  if (!isMac) return;
  if (which === 'accessibility') {
    systemPreferences.isTrustedAccessibilityClient(true); // zeigt macOS-Dialog
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  } else {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
});

ipcMain.on('session:active', (_e, active) => {
  sessionActive = !!active;
  if (win) win.setTitle(active ? 'RemoteDesk – Dieser Computer wird ferngesteuert' : 'RemoteDesk');
  if (isMac && app.dock) app.dock.setBadge(active ? '●' : '');
  updateTray();
  if (active) startClipWatch();
  else {
    stopClipWatch();
    setPrivacy(false);
    releaseAll().then(() => { if (loadConfig().lockOnEnd) lockComputer(); });
  }
});

// ---------- Fernsteuerung ----------
const pressedKeys = new Set();
const pressedButtons = new Set();
let scrollAccX = 0;
let scrollAccY = 0;

// Befehle der Reihe nach ausführen; Mausbewegungen zusammenfassen
const queue = [];
let busy = false;
function enqueue(msg) {
  if (msg.t === 'move' && queue.length && queue[queue.length - 1].t === 'move') queue[queue.length - 1] = msg;
  else queue.push(msg);
  if (!busy) drain();
}
async function drain() {
  busy = true;
  while (queue.length) {
    const msg = queue.shift();
    try { await handleInput(msg); } catch (err) { console.error('Eingabefehler:', err.message); }
  }
  busy = false;
}

function toScreenPoint(nx, ny) {
  const d = selectedDisplay || screen.getPrimaryDisplay();
  const b = d.bounds;
  const x = b.x + Math.min(Math.max(nx, 0), 1) * (b.width - 1);
  const y = b.y + Math.min(Math.max(ny, 0), 1) * (b.height - 1);
  // Windows: nut-js erwartet physische Pixel, Electron liefert DIP
  if (process.platform === 'win32') {
    const p = screen.dipToScreenPoint({ x, y });
    return new nut.Point(Math.round(p.x), Math.round(p.y));
  }
  return new nut.Point(Math.round(x), Math.round(y));
}

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight']);
const BUTTONS = () => ({ 0: nut.Button.LEFT, 1: nut.Button.MIDDLE, 2: nut.Button.RIGHT });

async function releaseAll() {
  if (!nut) return;
  for (const k of [...pressedKeys]) { try { await nut.keyboard.releaseKey(k); } catch {} }
  pressedKeys.clear();
  for (const b of [...pressedButtons]) { try { await nut.mouse.releaseButton(b); } catch {} }
  pressedButtons.clear();
}

async function handleInput(msg) {
  if (!nut) return;
  const { mouse, keyboard } = nut;
  switch (msg.t) {
    case 'move':
      await mouse.setPosition(toScreenPoint(msg.x, msg.y));
      break;
    case 'down': {
      const b = BUTTONS()[msg.b];
      if (b === undefined) return;
      if (msg.x !== undefined) await mouse.setPosition(toScreenPoint(msg.x, msg.y));
      await mouse.pressButton(b);
      pressedButtons.add(b);
      break;
    }
    case 'up': {
      const b = BUTTONS()[msg.b];
      if (b === undefined || !pressedButtons.has(b)) return;
      if (msg.x !== undefined) await mouse.setPosition(toScreenPoint(msg.x, msg.y));
      await mouse.releaseButton(b);
      pressedButtons.delete(b);
      break;
    }
    case 'wheel': {
      const per = loadConfigCached().scrollPixelsPerStep || 100;
      scrollAccX += msg.dx / per;
      scrollAccY += msg.dy / per;
      const sy = Math.trunc(scrollAccY);
      const sx = Math.trunc(scrollAccX);
      scrollAccY -= sy;
      scrollAccX -= sx;
      if (sy > 0) await mouse.scrollDown(sy);
      if (sy < 0) await mouse.scrollUp(-sy);
      if (sx > 0) await mouse.scrollRight(sx);
      if (sx < 0) await mouse.scrollLeft(-sx);
      break;
    }
    case 'kd': {
      const k = resolveKey(nut.Key, msg.code, msg.key);
      if (k === undefined) return;
      // Modifier, die laut Viewer gedrückt sind, hier aber fehlen, kurz mitdrücken
      const temp = [];
      if (msg.m && !MODIFIER_CODES.has(msg.code)) {
        const want = [[msg.m.c, 'LeftControl', 'RightControl'], [msg.m.s, 'LeftShift', 'RightShift'],
          [msg.m.a, 'LeftAlt', 'RightAlt'], [msg.m.w, 'LeftSuper', 'RightSuper']];
        for (const [on, l, r] of want) {
          if (on && !pressedKeys.has(nut.Key[l]) && !pressedKeys.has(nut.Key[r])) temp.push(nut.Key[l]);
        }
      }
      for (const t of temp) await keyboard.pressKey(t);
      await keyboard.pressKey(k);
      pressedKeys.add(k);
      for (const t of temp.reverse()) await keyboard.releaseKey(t);
      break;
    }
    case 'ku': {
      const k = resolveKey(nut.Key, msg.code, msg.key);
      if (k === undefined || !pressedKeys.has(k)) return;
      await keyboard.releaseKey(k);
      pressedKeys.delete(k);
      break;
    }
    case 'text': {
      // Gedrückte Modifier kurz loslassen, damit z. B. AltGr+Q wirklich "@" ergibt
      const held = [...pressedKeys];
      for (const k of held) await keyboard.releaseKey(k);
      await keyboard.type(String(msg.s).slice(0, 1000));
      for (const k of held) await keyboard.pressKey(k);
      break;
    }
    case 'combo': {
      const keys = (msg.keys || []).map((n) => resolveName(nut.Key, n)).filter((k) => k !== undefined);
      if (!keys.length) return;
      await keyboard.pressKey(...keys);
      await keyboard.releaseKey(...keys.slice().reverse());
      break;
    }
    case 'clipboard':
      clipboard.writeText(String(msg.text || ''));
      break;
    case 'releaseAll':
      await releaseAll();
      break;
  }
}

let cfgCache = null;
let cfgCacheTs = 0;
function loadConfigCached() {
  if (!cfgCache || Date.now() - cfgCacheTs > 5000) {
    cfgCache = loadConfig();
    cfgCacheTs = Date.now();
  }
  return cfgCache;
}

ipcMain.on('input', (_e, msg) => {
  if (msg && typeof msg === 'object') enqueue(msg);
});

// ---------- Benachrichtigungen ----------
ipcMain.on('notify', (_e, { title, body, force }) => {
  if (!force && !loadConfig().notify) return;
  if (!force && win && win.isVisible() && win.isFocused()) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: String(title || 'RemoteDesk'), body: String(body || ''), silent: false });
  n.on('click', showWindow);
  n.show();
});

// ---------- Computer sperren ----------
async function lockComputer() {
  try {
    if (process.platform === 'win32') {
      execFile('rundll32.exe', ['user32.dll,LockWorkStation']);
    } else if (isMac && nut) {
      // Ctrl+Cmd+Q = Bildschirm sperren
      await nut.keyboard.pressKey(nut.Key.LeftControl, nut.Key.LeftSuper, nut.Key.Q);
      await nut.keyboard.releaseKey(nut.Key.Q, nut.Key.LeftSuper, nut.Key.LeftControl);
    } else if (process.platform === 'linux') {
      execFile('loginctl', ['lock-session']);
    }
  } catch (err) { console.error('Sperren fehlgeschlagen:', err.message); }
}

// ---------- Privatmodus: Monitore hier schwarz, Übertragung bleibt sichtbar ----------
let privacyWins = [];
function setPrivacy(on) {
  privacyWins.forEach((w) => { try { w.destroy(); } catch {} });
  privacyWins = [];
  if (!on) return false;
  for (const d of screen.getAllDisplays()) {
    const w = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false, transparent: false, backgroundColor: '#000000', show: false, focusable: false,
      skipTaskbar: true, resizable: false, movable: false, hasShadow: false, enableLargerThanScreen: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    w.setContentProtection(true); // vom Bildschirm-Mitschnitt ausnehmen
    w.setIgnoreMouseEvents(true);
    w.setAlwaysOnTop(true, 'screen-saver');
    if (isMac) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<body style="margin:0;background:#000;color:#555;font:16px -apple-system,Segoe UI,sans-serif;display:grid;place-items:center;height:100vh;cursor:none">Dieser Computer wird gerade ferngesteuert</body>'));
    w.showInactive();
    privacyWins.push(w);
  }
  return true;
}
ipcMain.handle('privacy:set', (_e, on) => setPrivacy(!!on));

// ---------- Zwischenablage abgleichen ----------
let clipTimer = null;
let lastClip = '';
function startClipWatch() {
  stopClipWatch();
  lastClip = clipboard.readText();
  clipTimer = setInterval(() => {
    const t = clipboard.readText();
    if (t !== lastClip) {
      lastClip = t;
      if (t && t.length <= 15000 && win) win.webContents.send('clip:changed', t);
    }
  }, 800);
}
function stopClipWatch() { clearInterval(clipTimer); clipTimer = null; }
ipcMain.on('clip:set', (_e, text) => {
  text = String(text || '').slice(0, 200000);
  lastClip = text;
  clipboard.writeText(text);
});

// ---------- Dateien empfangen (in den Download-Ordner) ----------
const incoming = new Map(); // id -> { fd, file, name, size, got }
function safeName(name) {
  const base = path.basename(String(name || 'Datei')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180);
  return base && base !== '.' && base !== '..' ? base : 'Datei';
}
function uniquePath(dir, name) {
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name), i = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${stem} (${i++})${ext}`);
  return p;
}
ipcMain.handle('file:begin', (_e, { id, name, size }) => {
  const file = uniquePath(app.getPath('downloads'), safeName(name));
  const fd = fs.openSync(file, 'w');
  incoming.set(String(id), { fd, file, name: path.basename(file), size: Number(size) || 0, got: 0 });
  return { name: path.basename(file) };
});
ipcMain.handle('file:chunk', (_e, { id, data }) => {
  const f = incoming.get(String(id));
  if (!f) return false;
  const buf = Buffer.from(String(data), 'base64');
  fs.writeSync(f.fd, buf);
  f.got += buf.length;
  return true;
});
ipcMain.handle('file:end', (_e, { id, abort }) => {
  const f = incoming.get(String(id));
  if (!f) return null;
  incoming.delete(String(id));
  fs.closeSync(f.fd);
  if (abort) { try { fs.unlinkSync(f.file); } catch {} return null; }
  return { name: f.name, path: f.file };
});
ipcMain.handle('file:show', (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });

// ---------- Dateien senden (Auswahl erscheint hier auf dem Bildschirm) ----------
const outgoing = new Map(); // id -> { fd, size }
ipcMain.handle('file:pick', async () => {
  showWindow();
  const r = process.env.RD_TEST_PICK // nur für automatische Tests
    ? { canceled: false, filePaths: [process.env.RD_TEST_PICK] }
    : await dialog.showOpenDialog(win, { title: 'Datei an den anderen Computer senden', properties: ['openFile', 'multiSelections'] });
  if (r.canceled) return [];
  return r.filePaths.map((fp) => {
    const id = crypto.randomBytes(8).toString('hex');
    const size = fs.statSync(fp).size;
    outgoing.set(id, { fd: fs.openSync(fp, 'r'), size });
    return { id, name: path.basename(fp), size };
  });
});
ipcMain.handle('file:read', (_e, { id, offset, length }) => {
  const f = outgoing.get(String(id));
  if (!f) return null;
  const buf = Buffer.alloc(Math.min(length, Math.max(0, f.size - offset)));
  const n = fs.readSync(f.fd, buf, 0, buf.length, offset);
  return buf.subarray(0, n).toString('base64');
});
ipcMain.handle('file:close', (_e, id) => {
  const f = outgoing.get(String(id));
  if (f) { try { fs.closeSync(f.fd); } catch {} outgoing.delete(String(id)); }
});

// ---------- Verlauf ----------
const historyPath = () => path.join(app.getPath('userData'), 'history.json');
function readHistory() { try { return JSON.parse(fs.readFileSync(historyPath(), 'utf8')); } catch { return []; } }
ipcMain.handle('history:get', () => readHistory());
ipcMain.handle('history:add', (_e, entry) => {
  const list = readHistory();
  list.unshift({ ts: Date.now(), ...entry });
  fs.writeFileSync(historyPath(), JSON.stringify(list.slice(0, 200)), { mode: 0o600 });
  return list.slice(0, 200);
});
ipcMain.handle('history:update', (_e, { ts, patch }) => {
  const list = readHistory();
  const e = list.find((x) => x.ts === ts);
  if (e) Object.assign(e, patch);
  fs.writeFileSync(historyPath(), JSON.stringify(list), { mode: 0o600 });
  return list;
});
ipcMain.handle('history:clear', () => { fs.writeFileSync(historyPath(), '[]', { mode: 0o600 }); return []; });

// ---------- Updates (neue Version von GitHub) ----------
const REPO = 'Laudisa01/remote-desk';
function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'RemoteDesk-Updater', Accept: 'application/vnd.github+json' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}
let updateInfo = null;
async function checkUpdate() {
  try {
    const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!rel || !rel.tag_name || !newer(rel.tag_name, app.getVersion())) return null;
    const want = process.platform === 'win32' ? 'RemoteDesk-Setup.exe' : `RemoteDesk-${process.arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
    const asset = (rel.assets || []).find((a) => a.name === want);
    if (!asset) return null;
    updateInfo = { version: rel.tag_name.replace(/^v/, ''), url: asset.browser_download_url, name: asset.name, notes: rel.body || '' };
    if (win) win.webContents.send('update:available', updateInfo);
    return updateInfo;
  } catch { return null; }
}
ipcMain.handle('update:check', () => checkUpdate());
function download(url, file, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'RemoteDesk-Updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        return resolve(download(res.headers.location, file, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const out = fs.createWriteStream(file);
      res.on('data', (c) => { got += c.length; if (total) onProgress(got / total); });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(file)));
      out.on('error', reject);
    }).on('error', reject);
  });
}
function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(stdout))));
}
ipcMain.handle('update:install', async () => {
  if (!updateInfo) await checkUpdate();
  if (!updateInfo) return { ok: false, msg: 'Kein Update gefunden.' };
  const file = path.join(app.getPath('temp'), updateInfo.name);
  await download(updateInfo.url, file, (p) => win && win.webContents.send('update:progress', p));
  if (process.platform === 'win32') {
    spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
    quitting = true;
    setTimeout(() => app.quit(), 500);
    return { ok: true };
  }
  // Mac: DMG einhängen und die App in /Programme ersetzen
  const bundle = path.resolve(path.dirname(app.getPath('exe')), '..', '..');
  if (!bundle.endsWith('.app') || !bundle.startsWith('/Applications/')) {
    shell.openPath(file);
    return { ok: true, manual: true };
  }
  const mnt = fs.mkdtempSync(path.join(app.getPath('temp'), 'rdsk-'));
  await run('hdiutil', ['attach', file, '-nobrowse', '-quiet', '-mountpoint', mnt]);
  try {
    const src = path.join(mnt, 'RemoteDesk.app');
    const tmpApp = bundle + '.new';
    await run('rm', ['-rf', tmpApp]);
    await run('ditto', [src, tmpApp]);
    await run('xattr', ['-cr', tmpApp]);
    await run('rm', ['-rf', bundle]);
    await run('mv', [tmpApp, bundle]);
  } finally {
    await run('hdiutil', ['detach', mnt, '-quiet']).catch(() => {});
  }
  app.relaunch();
  quitting = true;
  setTimeout(() => app.quit(), 300);
  return { ok: true };
});
app.whenReady().then(() => {
  setTimeout(checkUpdate, 5000);
  setInterval(checkUpdate, 6 * 60 * 60 * 1000);
});
