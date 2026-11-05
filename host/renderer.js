// RemoteDesk – Host: fester Code, PIN-Prüfung, Bildschirmaufnahme und WebRTC (über PeerJS)
(() => {
  const $ = (id) => document.getElementById(id);
  const PREFIX = 'rdsk-';
  const statusEl = $('status');

  let cfg = {};
  let sources = [];
  let selected = null;
  let peer = null;
  let session = null; // { conn, call, stream }
  let retryTimer = null;
  let thumbRetried = false;

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

  // ---------- Start ----------
  if (host.platform === 'darwin') document.body.classList.add('mac');

  async function init() {
    cfg = await host.getConfig();
    $('code').textContent = cfg.deviceId.replace(/(\d{3})(?=\d)/g, '$1 ');
    $('viewerLink').textContent = cfg.viewerUrl.replace(/^https:\/\//, '').replace(/\/$/, '');
    $('viewerLink').onclick = (e) => { e.preventDefault(); host.openViewer(); };
    $('autostart').checked = cfg.autostart;
    $('requireConfirm').checked = cfg.requireConfirm;

    const perms = await host.checkPermissions();
    if (host.platform === 'darwin' && (perms.screen !== 'granted' || !perms.accessibility)) {
      $('perms').classList.remove('hidden');
      $('permScreen').disabled = perms.screen === 'granted';
      $('permAccess').disabled = perms.accessibility;
    }
    if (!perms.input) setStatus('Steuerungsmodul fehlt – der andere PC kann nur zusehen.', true);

    await loadSources();
    if (!cfg.hasPin) showPinSetup(false);
    else showMain();
    goOnline();
  }

  async function loadSources() {
    try { sources = await host.listSources(); } catch { sources = []; }
    const box = $('screens');
    box.innerHTML = '';
    let pick = sources.find((s) => s.displayId === cfg.displayId) || sources[0];
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
  $('autostart').onchange = async (e) => { cfg = await host.setConfig({ autostart: e.target.checked }); };
  $('requireConfirm').onchange = async (e) => { cfg = await host.setConfig({ requireConfirm: e.target.checked }); };
  $('permScreen').onclick = () => host.requestPermission('screen');
  $('permAccess').onclick = () => host.requestPermission('accessibility');

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
    const authTimeout = setTimeout(() => { if (!authed) conn.close(); }, 20000);

    conn.on('data', async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (!authed) {
        if (msg.t !== 'auth') return;
        if (session) {
          conn.send({ t: 'auth-fail', msg: 'Dieser Computer wird gerade schon ferngesteuert.' });
          return setTimeout(() => conn.close(), 500);
        }
        const res = await host.verifyPin(String(msg.pin || ''));
        if (!res.ok) {
          conn.send({ t: 'auth-fail', msg: res.msg });
          return setTimeout(() => conn.close(), 500);
        }
        if (cfg.requireConfirm) {
          conn.send({ t: 'info', msg: 'Warte auf Bestätigung am anderen Computer …' });
          if (!(await host.confirmAccess())) {
            conn.send({ t: 'auth-fail', msg: 'Der Zugriff wurde am anderen Computer abgelehnt.' });
            return setTimeout(() => conn.close(), 500);
          }
        }
        if (session) {
          conn.send({ t: 'auth-fail', msg: 'Dieser Computer wird gerade schon ferngesteuert.' });
          return setTimeout(() => conn.close(), 500);
        }
        authed = true;
        clearTimeout(authTimeout);
        startSession(conn);
        return;
      }
      // Ab hier nur noch Befehle einer angemeldeten Verbindung
      if (!session || session.conn !== conn) return;
      if (msg.t === 'quality') setQuality(msg.v);
      else if (msg.t === 'screen') switchScreen(String(msg.id || ''));
      else host.input(msg);
    });
    conn.on('close', () => {
      clearTimeout(authTimeout);
      if (session && session.conn === conn) endSession('Die Verbindung wurde beendet.');
    });
    conn.on('error', () => {});
  }

  function captureScreen(src) {
    return host.selectDisplay(src.displayId).then((dims) =>
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: src.id,
            maxWidth: dims.width,
            maxHeight: dims.height,
            maxFrameRate: 30,
          },
        },
      })
    );
  }

  function screenList() {
    return sources.map((s, i) => ({
      id: s.id,
      label: `Bildschirm ${i + 1}${s.primary ? ' (Haupt)' : ''} · ${s.size}`,
    }));
  }
  function sendScreens() {
    if (!session) return;
    try { session.conn.send({ t: 'screens', list: screenList(), cur: session.src.id }); } catch {}
  }

  // Bildschirm während der Sitzung wechseln (vom Browser aus angefordert)
  async function switchScreen(id) {
    if (!session || session.switching) return;
    await loadSources(); // Monitore könnten an- oder abgesteckt worden sein
    const src = sources.find((s) => s.id === id);
    if (!src || src.id === session.src.id) return sendScreens();
    const s = session;
    s.switching = true;
    try {
      const stream = await captureScreen(src);
      if (session !== s) { stream.getTracks().forEach((t) => t.stop()); return; }
      const track = stream.getVideoTracks()[0];
      track.contentHint = 'detail';
      const pc = s.call && s.call.peerConnection;
      const sender = pc && pc.getSenders().find((x) => x.track && x.track.kind === 'video');
      if (!sender) throw new Error('keine Videoverbindung');
      await sender.replaceTrack(track);
      s.stream.getTracks().forEach((t) => t.stop());
      s.stream = stream;
      s.src = src;
    } catch (err) {
      console.warn('Bildschirmwechsel:', err.message);
      if (session === s) await host.selectDisplay(s.src.displayId); // Maus wieder auf alten Bildschirm
    } finally {
      s.switching = false;
      sendScreens();
    }
  }

  async function startSession(conn) {
    await loadSources();
    if (!selected) {
      conn.send({ t: 'auth-fail', msg: 'Auf dem anderen Computer ist keine Bildschirmaufnahme möglich (Freigabe fehlt).' });
      return setTimeout(() => conn.close(), 500);
    }
    const src = selected;
    let stream;
    try {
      stream = await captureScreen(src);
    } catch (err) {
      conn.send({ t: 'auth-fail', msg: 'Bildschirmaufnahme am anderen Computer nicht möglich: ' + err.message });
      setStatus('Bildschirmaufnahme nicht möglich: ' + err.message, true);
      return setTimeout(() => conn.close(), 500);
    }
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail'; // scharfe Schrift bevorzugen

    session = { conn, stream, call: null, src, switching: false };
    conn.send({ t: 'auth-ok', name: cfg.computerName });
    sendScreens();
    const call = peer.call(conn.peer, stream);
    session.call = call;
    call.on('close', () => { if (session && session.call === call) endSession('Die Verbindung wurde beendet.'); });
    call.on('error', () => {});
    const waitPc = setInterval(() => {
      if (call.peerConnection) {
        clearInterval(waitPc);
        call.peerConnection.addEventListener('connectionstatechange', () => {
          const s = call.peerConnection.connectionState;
          if (s === 'connected') setQuality('high');
          if (s === 'failed') endSession('Verbindung fehlgeschlagen.');
        });
      }
    }, 50);

    $('activeInfo').textContent = 'Klicke auf „Verbindung trennen“, um den Zugriff sofort zu beenden.';
    host.setSessionActive(true);
    showMain();
    setStatus('');
  }

  async function setQuality(level) {
    const pc = session && session.call && session.call.peerConnection;
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

  function endSession(reason) {
    const s = session;
    if (!s) return;
    session = null;
    try { s.call && s.call.close(); } catch {}
    try { s.conn.close(); } catch {}
    s.stream.getTracks().forEach((t) => t.stop());
    host.setSessionActive(false);
    showMain();
    setStatus(reason || '');
  }

  $('stopBtn').onclick = () => endSession('Verbindung getrennt.');
  host.onStopRequest(() => endSession('Verbindung getrennt.'));
  window.addEventListener('online', () => { if (!peer || peer.disconnected || peer.destroyed) goOnline(); });

  init();
})();
