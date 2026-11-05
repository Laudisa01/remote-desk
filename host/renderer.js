// RemoteDesk – Host: fester Code, PIN-Prüfung, Bildschirmaufnahme und WebRTC (über PeerJS)
(() => {
  const $ = (id) => document.getElementById(id);
  const PREFIX = 'rdsk-';
  const MAX_VIEWERS = 4; // 1 steuert, bis zu 3 sehen zu
  const CHUNK = 11 * 1024; // Dateiübertragung: Stückgröße (PeerJS erlaubt max. ~16 KB pro Nachricht)
  const INPUT_TYPES = new Set(['move', 'down', 'up', 'wheel', 'kd', 'ku', 'text', 'combo', 'clipboard', 'releaseAll']);
  const statusEl = $('status');

  let cfg = {};
  let sources = [];
  let selected = null;
  let peer = null;
  let retryTimer = null;
  let thumbRetried = false;
  // session = { stream, video: {track, stop}, audioTrack, srcId, viewers: [], switching, started }
  // viewer  = { conn, call, role: 'control'|'view', ua, once, histTs, since, rec, chain, files: Map }
  let session = null;

  if (host.platform === 'darwin') document.body.classList.add('mac');

  function setStatus(t, err = false) {
    statusEl.textContent = t || '';
    statusEl.classList.toggle('err', err);
  }
  function setOnline(on, text) {
    const b = $('online');
    b.textContent = text || (on ? '● Online' : '● Offline');
    b.className = 'badge ' + (on ? 'on' : 'off');
  }
  function showMain() {
    const active = !!session;
    $('setup').classList.add('hidden');
    $('ready').classList.toggle('hidden', active);
    $('active').classList.toggle('hidden', !active);
    $('settings').classList.toggle('hidden', active);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function uaShort(ua) {
    ua = String(ua || '');
    const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const o = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
    return o ? `${b} auf ${o}` : b;
  }

  // ---------- Start ----------
  async function init() {
    cfg = await host.getConfig();
    $('code').textContent = cfg.deviceId.replace(/(\d{3})(?=\d)/g, '$1 ');
    $('viewerLink').textContent = cfg.viewerUrl.replace(/^https:\/\//, '').replace(/\/$/, '');
    $('viewerLink').onclick = (e) => { e.preventDefault(); host.openViewer(); };
    $('version').textContent = 'Version ' + cfg.version;
    for (const k of ['autostart', 'requireConfirm', 'audio', 'multiView', 'notify', 'lockOnEnd']) {
      $(k).checked = !!cfg[k];
      $(k).onchange = async (e) => { cfg = await host.setConfig({ [k]: e.target.checked }); };
    }

    const perms = await host.checkPermissions();
    if (host.platform === 'darwin' && (perms.screen !== 'granted' || !perms.accessibility)) {
      $('perms').classList.remove('hidden');
      $('permScreen').disabled = perms.screen === 'granted';
      $('permAccess').disabled = perms.accessibility;
    }
    if (!perms.input) setStatus('Steuerungsmodul fehlt – der andere PC kann nur zusehen.', true);

    await loadSources();
    renderHistory(await host.historyGet());
    if (!cfg.hasPin) showPinSetup(false);
    else showMain();
    goOnline();
  }

  async function loadSources() {
    try { sources = await host.listSources(); } catch { sources = []; }
    const box = $('screens');
    box.innerHTML = '';
    const pick = sources.find((s) => s.displayId === cfg.displayId) || sources[0];
    sources.forEach((s, i) => {
      const el = document.createElement('div');
      el.className = 'screen-opt';
      const hasThumb = s.thumb && s.thumb.length > 40;
      const img = document.createElement(hasThumb ? 'img' : 'div');
      if (hasThumb) img.src = s.thumb; else img.className = 'ph';
      const label = document.createElement('span');
      label.textContent = `${sources.length > 1 ? `Bildschirm ${i + 1}${s.primary ? ' (Haupt)' : ''}` : 'Gesamter Bildschirm'} · ${s.size}`;
      el.append(img, label);
      el.onclick = () => select(s, el, true);
      box.appendChild(el);
      if (s === pick) select(s, el, false);
    });
    // macOS liefert beim ersten Abruf oft leere Vorschaubilder – kurz danach noch einmal holen
    if (sources.some((s) => !s.thumb || s.thumb.length <= 40) && !thumbRetried) {
      thumbRetried = true;
      setTimeout(() => { if (!session) loadSources(); }, 1500);
    }
    if (!sources.length) {
      box.innerHTML = '<span class="small muted">Kein Bildschirm verfügbar – unter macOS die Freigabe „Bildschirmaufnahme“ erteilen.</span>';
    }
  }
  function select(s, el, save) {
    selected = s;
    document.querySelectorAll('.screen-opt').forEach((x) => x.classList.toggle('sel', x === el));
    if (save) host.setConfig({ displayId: s.displayId });
  }

  // ---------- PIN ----------
  function showPinSetup(change) {
    $('setupTitle').textContent = change ? 'PIN ändern' : 'PIN festlegen';
    $('oldPin').classList.toggle('hidden', !change);
    $('cancelPin').classList.toggle('hidden', !change);
    ['oldPin', 'pin1', 'pin2'].forEach((id) => ($(id).value = ''));
    $('setup').classList.remove('hidden');
    $('ready').classList.add('hidden');
    $('settings').classList.add('hidden');
    (change ? $('oldPin') : $('pin1')).focus();
  }
  $('savePin').onclick = async () => {
    const p1 = $('pin1').value.trim();
    const p2 = $('pin2').value.trim();
    if (p1 !== p2) return setStatus('Die beiden PINs stimmen nicht überein.', true);
    const res = await host.setPin(p1, $('oldPin').value.trim());
    if (!res.ok) return setStatus(res.msg, true);
    cfg = await host.getConfig();
    setStatus('PIN gespeichert.');
    showMain();
  };
  $('cancelPin').onclick = () => { setStatus(''); showMain(); };
  $('changePin').onclick = () => showPinSetup(true);
  $('permScreen').onclick = () => host.requestPermission('screen');
  $('permAccess').onclick = () => host.requestPermission('accessibility');

  // ---------- Einmal-PIN (Hilfe-Zugang) ----------
  let onceTimer = null;
  function hideOnce() {
    clearInterval(onceTimer);
    $('onceBox').classList.add('hidden');
    $('onceIdle').classList.remove('hidden');
  }
  $('onceBtn').onclick = async () => {
    const o = await host.createOncePin();
    $('oncePin').textContent = o.pin.replace(/(\d{3})(?=\d)/g, '$1 ');
    $('onceIdle').classList.add('hidden');
    $('onceBox').classList.remove('hidden');
    clearInterval(onceTimer);
    const tick = () => {
      const left = Math.max(0, o.expires - Date.now());
      $('onceLeft').textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
      if (!left) { hideOnce(); host.clearOncePin(); }
    };
    tick();
    onceTimer = setInterval(tick, 1000);
  };
  $('onceCancel').onclick = () => { host.clearOncePin(); hideOnce(); };
  host.onOnceUsed(() => hideOnce());

  // ---------- Verlauf ----------
  function renderHistory(list) {
    const box = $('history');
    box.innerHTML = '';
    if (!list || !list.length) {
      box.innerHTML = '<div class="empty">Noch keine Zugriffe.</div>';
      return;
    }
    for (const e of list.slice(0, 50)) {
      const item = document.createElement('div');
      item.className = 'h-item' + (e.ok ? '' : ' fail');
      const d = new Date(e.ts);
      const what = e.ok
        ? `${e.once ? 'Hilfe-Zugang' : e.role === 'view' ? 'Zugeschaut' : 'Ferngesteuert'}${e.dur ? ' · ' + (e.dur < 60 ? e.dur + ' s' : Math.round(e.dur / 60) + ' Min.') : ''}`
        : (e.reason || 'Abgelehnt');
      item.innerHTML = '<span class="h-icon"></span><div class="h-main"><div></div><div></div></div><div class="h-time"></div>';
      item.querySelector('.h-main div').textContent = what;
      item.querySelector('.h-main div:last-child').textContent = uaShort(e.ua);
      item.querySelector('.h-time').textContent = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      box.appendChild(item);
    }
  }
  $('historyClear').onclick = async () => renderHistory(await host.historyClear());

  // ---------- Updates ----------
  function showUpdate(info) {
    if (!info) return;
    $('updateTitle').textContent = `Version ${info.version} verfügbar`;
    $('updateText').textContent = 'Installiert die neue Version und startet RemoteDesk neu.';
    $('update').classList.remove('hidden');
  }
  host.onUpdate(showUpdate);
  host.onUpdateProgress((p) => { $('updateText').textContent = `Wird geladen … ${Math.round(p * 100)} %`; });
  $('updateBtn').onclick = async () => {
    if (session) return setStatus('Bitte erst die laufende Verbindung trennen.', true);
    $('updateBtn').disabled = true;
    try {
      const r = await host.installUpdate();
      if (!r.ok) throw new Error(r.msg);
      $('updateText').textContent = r.manual ? 'RemoteDesk aus dem geöffneten Fenster in „Programme“ ziehen und ersetzen.' : 'Wird installiert …';
    } catch (err) {
      $('updateText').textContent = 'Update fehlgeschlagen: ' + err.message;
      $('updateBtn').disabled = false;
    }
  };

  // ---------- Online gehen (fester Code) ----------
  function goOnline() {
    clearTimeout(retryTimer);
    if (peer && !peer.destroyed) peer.destroy();
    setOnline(false, '● Verbinde …');
    peer = new Peer(PREFIX + cfg.deviceId, { debug: 1 });

    peer.on('open', () => {
      setOnline(true);
      if (statusEl.textContent.startsWith('Keine Verbindung')) setStatus('');
    });
    peer.on('disconnected', () => {
      setOnline(false);
      if (!peer.destroyed) setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 3000);
    });
    peer.on('error', (err) => {
      setOnline(false);
      if (err.type === 'unavailable-id') {
        setStatus('Dieser Code ist gerade schon online (läuft RemoteDesk noch auf einem anderen Gerät mit derselben Konfiguration?). Neuer Versuch in 30 s.', true);
        retryTimer = setTimeout(goOnline, 30000);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        setStatus('Keine Verbindung zum Internet – neuer Versuch in 10 s.', true);
        retryTimer = setTimeout(goOnline, 10000);
      } else if (err.type !== 'peer-unavailable') {
        console.warn('PeerJS:', err.type, err.message);
      }
    });
    peer.on('connection', onConnection);
  }

  // ---------- Eingehende Verbindung ----------
  function onConnection(conn) {
    let authed = false;
    let viewer = null;
    const authTimeout = setTimeout(() => { if (!authed) conn.close(); }, 30000);
    const reject = (msg) => {
      conn.send({ t: 'auth-fail', msg });
      setTimeout(() => conn.close(), 500);
    };
    const full = () => session && (!cfg.multiView || session.viewers.length >= MAX_VIEWERS);

    conn.on('data', async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (!authed) {
        if (msg.t !== 'auth' || conn._checking) return;
        conn._checking = true;
        const ua = String(msg.ua || '').slice(0, 300);
        if (full()) return reject('Dieser Computer wird gerade schon ferngesteuert.');
        const res = await host.verifyPin(String(msg.pin || ''));
        if (!res.ok) {
          renderHistory(await host.historyAdd({ ok: false, reason: res.msg.startsWith('Zu viele') ? 'Gesperrt (zu viele Versuche)' : 'Falsche PIN', ua }));
          host.notify('Fehlgeschlagener Zugriff', 'Jemand hat eine falsche PIN eingegeben.');
          return reject(res.msg);
        }
        let role = session && session.viewers.some((v) => v.role === 'control') ? 'view' : 'control';
        if (cfg.requireConfirm || res.once) {
          conn.send({ t: 'info', msg: 'Warte auf Bestätigung am anderen Computer …' });
          if (!(await host.confirmAccess(res.once ? 'once' : role))) {
            renderHistory(await host.historyAdd({ ok: false, reason: 'Am Computer abgelehnt', ua }));
            return reject('Der Zugriff wurde am anderen Computer abgelehnt.');
          }
        }
        if (full()) return reject('Dieser Computer wird gerade schon ferngesteuert.');
        role = session && session.viewers.some((v) => v.role === 'control') ? 'view' : 'control';
        authed = true;
        clearTimeout(authTimeout);
        viewer = await addViewer(conn, role, ua, !!res.once);
        return;
      }
      if (viewer && session && session.viewers.includes(viewer)) handleMessage(viewer, msg);
    });
    conn.on('close', () => {
      clearTimeout(authTimeout);
      if (viewer) removeViewer(viewer, 'Die Verbindung wurde beendet.');
    });
    conn.on('error', () => {});
  }

  // ---------- Bildschirm aufnehmen ----------
  async function captureOne(src) {
    const dims = await host.selectDisplay(src.displayId);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxWidth: dims.width, maxHeight: dims.height, maxFrameRate: 30 } },
    });
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail'; // scharfe Schrift bevorzugen
    return { track, stop: () => stream.getTracks().forEach((t) => t.stop()) };
  }

  // Alle Bildschirme nebeneinander in ein Bild zusammensetzen
  async function captureAll() {
    const area = await host.selectDisplay('all');
    const U = area.bounds;
    const k = Math.min(3840 / U.width, 2160 / U.height, 2);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(U.width * k);
    canvas.height = Math.round(U.height * k);
    const ctx = canvas.getContext('2d');
    const parts = [];
    for (const s of sources) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: s.id, maxWidth: Math.round(s.bounds.width * s.scale), maxHeight: Math.round(s.bounds.height * s.scale), maxFrameRate: 30 } },
      });
      const v = document.createElement('video');
      v.muted = true;
      v.srcObject = stream;
      await v.play();
      parts.push({ v, stream, x: (s.bounds.x - U.x) * k, y: (s.bounds.y - U.y) * k, w: s.bounds.width * k, h: s.bounds.height * k });
    }
    const draw = () => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const p of parts) ctx.drawImage(p.v, p.x, p.y, p.w, p.h);
    };
    draw();
    const timer = setInterval(draw, 33); // läuft auch, wenn das Fenster versteckt ist
    const out = canvas.captureStream(30);
    const track = out.getVideoTracks()[0];
    track.contentHint = 'detail';
    return {
      track,
      stop: () => {
        clearInterval(timer);
        track.stop();
        parts.forEach((p) => p.stream.getTracks().forEach((t) => t.stop()));
      },
    };
  }

  function captureVideo(srcId) {
    if (srcId === 'all') return captureAll();
    return captureOne(sources.find((s) => s.id === srcId) || selected);
  }

  // Systemton (Windows immer, Mac je nach macOS-Version)
  async function captureAudio() {
    if (!cfg.audio) return null;
    try {
      const s = await Promise.race([
        navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
        sleep(5000).then(() => { throw new Error('timeout'); }),
      ]);
      s.getVideoTracks().forEach((t) => t.stop());
      return s.getAudioTracks()[0] || null;
    } catch (err) {
      console.warn('Kein Systemton:', err.message);
      return null;
    }
  }

  function screenList() {
    const list = sources.map((s, i) => ({ id: s.id, label: `Bildschirm ${i + 1}${s.primary ? ' (Haupt)' : ''} · ${s.size}` }));
    if (sources.length > 1) list.push({ id: 'all', label: 'Alle Bildschirme' });
    return list;
  }
  function send(v, msg) { try { if (v.conn.open) v.conn.send(msg); } catch {} }
  function broadcast(msg, except) { if (session) session.viewers.forEach((v) => v !== except && send(v, msg)); }
  function sendScreens() { if (session) broadcast({ t: 'screens', list: screenList(), cur: session.srcId }); }

  async function startSession() {
    await loadSources();
    if (!selected) throw new Error('Auf dem anderen Computer ist keine Bildschirmaufnahme möglich (Freigabe fehlt).');
    const video = await captureVideo(selected.id);
    const audioTrack = await captureAudio();
    const stream = new MediaStream([video.track, ...(audioTrack ? [audioTrack] : [])]);
    session = { stream, video, audioTrack, srcId: selected.id, viewers: [], switching: false, started: Date.now() };
    host.setSessionActive(true);
    showMain();
    setStatus('');
  }

  async function addViewer(conn, role, ua, once) {
    if (!session) {
      try {
        await startSession();
      } catch (err) {
        conn.send({ t: 'auth-fail', msg: err.message.startsWith('Auf dem') ? err.message : 'Bildschirmaufnahme am anderen Computer nicht möglich: ' + err.message });
        setStatus('Bildschirmaufnahme nicht möglich: ' + err.message, true);
        setTimeout(() => conn.close(), 500);
        return null;
      }
    }
    const v = { conn, call: null, role, ua, once, since: Date.now(), rec: false, chain: Promise.resolve(), files: new Map() };
    session.viewers.push(v);
    send(v, { t: 'auth-ok', name: cfg.computerName, role, audio: !!session.audioTrack });
    send(v, { t: 'screens', list: screenList(), cur: session.srcId });

    const call = peer.call(conn.peer, session.stream);
    v.call = call;
    call.on('close', () => removeViewer(v, 'Die Verbindung wurde beendet.'));
    call.on('error', () => {});
    const waitPc = setInterval(() => {
      if (!call.peerConnection) return;
      clearInterval(waitPc);
      call.peerConnection.addEventListener('connectionstatechange', () => {
        const s = call.peerConnection.connectionState;
        if (s === 'connected') setQuality(v, 'high');
        if (s === 'failed') removeViewer(v, 'Verbindung fehlgeschlagen.');
      });
    }, 50);

    const list = await host.historyAdd({ ok: true, ua, role, once });
    v.histTs = list[0].ts;
    renderHistory(list);
    host.notify(role === 'view' ? 'Neuer Zuschauer' : 'Fernzugriff gestartet', `${uaShort(ua)} ist jetzt verbunden${role === 'view' ? ' (sieht nur zu)' : ''}.`);
    renderActive();
    broadcast({ t: 'viewers', n: session.viewers.length });
    return v;
  }

  function removeViewer(v, reason) {
    if (!session || !session.viewers.includes(v)) return;
    session.viewers = session.viewers.filter((x) => x !== v);
    try { v.call && v.call.close(); } catch {}
    try { v.conn.close(); } catch {}
    for (const [id] of v.files) host.fileEnd({ id, abort: true });
    v.files.clear();
    if (v.histTs) host.historyUpdate({ ts: v.histTs, patch: { dur: Math.round((Date.now() - v.since) / 1000) } }).then(renderHistory);
    if (!session.viewers.length) return endSession(reason);
    if (v.role === 'control') {
      const next = session.viewers[0];
      next.role = 'control';
      send(next, { t: 'role', role: 'control' });
      host.input({ t: 'releaseAll' });
    }
    broadcast({ t: 'viewers', n: session.viewers.length });
    renderActive();
  }

  function endSession(reason) {
    const s = session;
    if (!s) return;
    session = null;
    s.viewers.forEach((v) => {
      try { v.call && v.call.close(); } catch {}
      try { v.conn.close(); } catch {}
      for (const [id] of v.files) host.fileEnd({ id, abort: true });
      if (v.histTs) host.historyUpdate({ ts: v.histTs, patch: { dur: Math.round((Date.now() - v.since) / 1000) } }).then(renderHistory);
    });
    s.video.stop();
    if (s.audioTrack) s.audioTrack.stop();
    host.setSessionActive(false);
    $('privacy').checked = false;
    $('chatLog').innerHTML = '<p class="small muted center chat-empty">Nachrichten an die verbundene Person erscheinen hier.</p>';
    $('transferList').innerHTML = '';
    $('transfers').classList.add('hidden');
    showMain();
    setStatus(reason || '');
  }

  function renderActive() {
    if (!session) return;
    const vs = session.viewers;
    const ctrl = vs.find((v) => v.role === 'control');
    const watchers = vs.filter((v) => v.role === 'view').length;
    let t = ctrl ? `${uaShort(ctrl.ua)} steuert diesen Computer.` : '';
    if (watchers) t += ` ${watchers} ${watchers === 1 ? 'weitere Person sieht' : 'weitere Personen sehen'} zu.`;
    $('viewerInfo').textContent = t.trim();
    $('recNotice').classList.toggle('hidden', !vs.some((v) => v.rec));
  }

  // ---------- Bildschirm wechseln ----------
  async function switchScreen(id) {
    if (!session || session.switching) return;
    if (id !== 'all') await loadSources();
    if (id !== 'all' && !sources.some((s) => s.id === id)) return sendScreens();
    if (id === session.srcId) return sendScreens();
    const s = session;
    s.switching = true;
    try {
      const video = await captureVideo(id);
      if (session !== s) { video.stop(); return; }
      for (const v of s.viewers) {
        const pc = v.call && v.call.peerConnection;
        const sender = pc && pc.getSenders().find((x) => x.track && x.track.kind === 'video');
        if (sender) await sender.replaceTrack(video.track);
      }
      s.stream.removeTrack(s.video.track);
      s.stream.addTrack(video.track);
      s.video.stop();
      s.video = video;
      s.srcId = id;
    } catch (err) {
      console.warn('Bildschirmwechsel:', err.message);
      if (session === s) {
        const cur = sources.find((x) => x.id === s.srcId);
        await host.selectDisplay(s.srcId === 'all' ? 'all' : cur ? cur.displayId : null);
      }
    } finally {
      s.switching = false;
      sendScreens();
    }
  }

  async function setQuality(v, level) {
    const pc = v.call && v.call.peerConnection;
    if (!pc) return;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return;
    const presets = {
      high: { maxBitrate: 12_000_000, scaleResolutionDownBy: 1, maxFramerate: 30 },
      medium: { maxBitrate: 4_000_000, scaleResolutionDownBy: 1.5, maxFramerate: 25 },
      low: { maxBitrate: 1_200_000, scaleResolutionDownBy: 2, maxFramerate: 15 },
    };
    const p = presets[level] || presets.high;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    Object.assign(params.encodings[0], p);
    params.degradationPreference = 'maintain-resolution';
    try { await sender.setParameters(params); } catch (err) { console.warn('Qualität:', err.message); }
  }

  // ---------- Nachrichten der Viewer ----------
  function handleMessage(v, msg) {
    switch (msg.t) {
      case 'chat': {
        const text = String(msg.text || '').slice(0, 1000);
        if (!text) return;
        addChat(text, false, uaShort(v.ua));
        broadcast({ t: 'chat', text, from: uaShort(v.ua) }, v);
        host.notify('Neue Nachricht', text);
        return;
      }
      case 'quality': return setQuality(v, msg.v);
      case 'rec':
        v.rec = !!msg.on;
        renderActive();
        if (v.rec) host.notify('Aufnahme gestartet', 'Die Fernsitzung wird aufgezeichnet.', true);
        return;
    }
    if (v.role !== 'control') return; // Zuschauer dürfen nicht steuern
    switch (msg.t) {
      case 'screen': return switchScreen(String(msg.id || ''));
      case 'clip': return host.setClipboard(String(msg.text || ''));
      case 'file-start':
      case 'file-chunk':
      case 'file-end':
        v.chain = v.chain.then(() => receiveFile(v, msg)).catch((err) => console.warn('Datei:', err.message));
        return;
      case 'file-pick': return sendFiles(v);
      default:
        if (INPUT_TYPES.has(msg.t)) host.input(msg);
    }
  }

  // Zwischenablage hier geändert → an die steuernde Person
  host.onClipboard((text) => {
    if (!session) return;
    const ctrl = session.viewers.find((v) => v.role === 'control');
    if (ctrl) send(ctrl, { t: 'clip', text });
  });

  // ---------- Chat ----------
  function addChat(text, mine, who) {
    const log = $('chatLog');
    const empty = log.querySelector('.chat-empty');
    if (empty) empty.remove();
    const m = document.createElement('div');
    m.className = 'msg ' + (mine ? 'me' : 'them');
    m.textContent = text;
    const meta = document.createElement('div');
    meta.className = 'msg-meta' + (mine ? ' me' : '');
    meta.textContent = (mine ? 'Du' : who) + ' · ' + new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    log.append(m, meta);
    log.scrollTop = log.scrollHeight;
  }
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text || !session) return;
    $('chatInput').value = '';
    addChat(text, true);
    broadcast({ t: 'chat', text, from: cfg.computerName });
  };

  // ---------- Dateien ----------
  function transferItem(id, name, size, label) {
    $('transfers').classList.remove('hidden');
    let el = document.querySelector(`[data-tr="${CSS.escape(id)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tr-item';
      el.dataset.tr = id;
      el.innerHTML = '<div class="tr-head"><span class="tr-name"></span><span class="tr-state muted"></span></div><div class="tr-bar"><div></div></div>';
      $('transferList').prepend(el);
    }
    el.querySelector('.tr-name').textContent = name;
    el.querySelector('.tr-state').textContent = label || fmtSize(size);
    return el;
  }
  function setProgress(el, p, label) {
    el.querySelector('.tr-bar div').style.width = Math.round(p * 100) + '%';
    if (label) el.querySelector('.tr-state').textContent = label;
  }

  async function receiveFile(v, msg) {
    const id = String(msg.id || '');
    if (msg.t === 'file-start') {
      const r = await host.fileBegin({ id, name: msg.name, size: msg.size });
      v.files.set(id, { name: r.name, size: Number(msg.size) || 0, got: 0, el: transferItem(id, r.name, msg.size, 'Empfange …') });
      return;
    }
    const f = v.files.get(id);
    if (!f) return;
    if (msg.t === 'file-chunk') {
      await host.fileChunk({ id, data: msg.data });
      f.got += Math.floor(String(msg.data).length * 3 / 4);
      setProgress(f.el, f.size ? f.got / f.size : 0, `${fmtSize(f.got)} von ${fmtSize(f.size)}`);
    } else if (msg.t === 'file-end') {
      v.files.delete(id);
      const r = await host.fileEnd({ id, abort: !!msg.abort });
      if (!r) { setProgress(f.el, 0, 'Abgebrochen'); return; }
      f.el.classList.add('done');
      setProgress(f.el, 1, 'In „Downloads“ gespeichert');
      f.el.querySelector('.tr-name').style.cursor = 'pointer';
      f.el.querySelector('.tr-name').onclick = () => host.fileShow(r.path);
      send(v, { t: 'file-saved', id, name: r.name });
      host.notify('Datei empfangen', `${r.name} wurde in „Downloads“ gespeichert.`);
    }
  }

  async function sendFiles(v) {
    const files = await host.filePick();
    for (const f of files) {
      if (!session || !session.viewers.includes(v)) break;
      const el = transferItem(f.id, f.name, f.size, 'Sende …');
      send(v, { t: 'file-start', id: f.id, name: f.name, size: f.size });
      let offset = 0;
      let ok = true;
      while (offset < f.size) {
        if (!session || !session.viewers.includes(v)) { ok = false; break; }
        const data = await host.fileRead({ id: f.id, offset, length: CHUNK });
        if (data === null) { ok = false; break; }
        const dc = v.conn.dataChannel;
        while (dc && dc.bufferedAmount > 2 * 1024 * 1024) await sleep(25);
        send(v, { t: 'file-chunk', id: f.id, data });
        offset += CHUNK;
        setProgress(el, Math.min(1, offset / f.size), `${fmtSize(Math.min(offset, f.size))} von ${fmtSize(f.size)}`);
      }
      send(v, { t: 'file-end', id: f.id, abort: !ok });
      await host.fileClose(f.id);
      if (ok) { el.classList.add('done'); setProgress(el, 1, 'Gesendet'); }
      else setProgress(el, 0, 'Abgebrochen');
    }
  }

  // ---------- Bedienelemente ----------
  $('privacy').onchange = async (e) => {
    const ok = await host.setPrivacy(e.target.checked);
    if (e.target.checked && !ok) e.target.checked = false;
  };
  $('stopBtn').onclick = () => endSession('Verbindung getrennt.');
  host.onStopRequest(() => endSession('Verbindung getrennt.'));
  window.addEventListener('online', () => { if (!peer || peer.disconnected || peer.destroyed) goOnline(); });

  init();
})();
