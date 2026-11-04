// RemoteDesk – Host-App (läuft auf dem Computer, der gesteuert wird)
const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, clipboard, shell,
  systemPreferences, Tray, Menu, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
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

ipcMain.handle('pin:verify', async (_e, pin) => {
  const cfg = loadConfig();
  const now = Date.now();
  fails = fails.filter((t) => now - t < LOCK_MS);
  if (fails.length >= MAX_FAILS) {
    const mins = Math.ceil((fails[0] + LOCK_MS - now) / 60000);
    return { ok: false, msg: `Zu viele falsche PINs. Gesperrt für ${mins} Min.` };
  }
  await new Promise((r) => setTimeout(r, 800)); // bremst Durchprobieren
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
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // Übertragung soll auch im Hintergrund flüssig bleiben
    },
  });
  win.setMenuBarVisibility(false);
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
      size: `${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}`,
      thumb: s.thumbnail.toDataURL(),
    };
  });
});

ipcMain.handle('display:select', (_e, displayId) => {
  selectedDisplay = screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
  return {
    width: Math.round(selectedDisplay.size.width * selectedDisplay.scaleFactor),
    height: Math.round(selectedDisplay.size.height * selectedDisplay.scaleFactor),
  };
});

ipcMain.handle('access:confirm', async () => {
  showWindow();
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Zugriff erlauben', 'Ablehnen'],
    defaultId: 1,
    cancelId: 1,
    title: 'Fernzugriff',
    message: 'Jemand möchte auf diesen Computer zugreifen.',
    detail: 'Die richtige PIN wurde eingegeben. Die Person kann deinen Bildschirm sehen und Maus und Tastatur steuern.',
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
  if (!active) releaseAll();
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
