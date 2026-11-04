// RemoteDesk – Viewer (läuft im Browser des steuernden PCs)
(() => {
  const $ = (id) => document.getElementById(id);
  const PREFIX = 'rdsk-';
  const STORE_KEY = 'remotedesk.computers';
  const connectScreen = $('connect');
  const sessionScreen = $('session');
  const form = $('codeForm');
  const codeInput = $('codeInput');
  const pinInput = $('pinInput');
  const connectBtn = $('connectBtn');
  const statusEl = $('status');
  const video = $('remote');
  const overlay = $('overlay');
  const toolbar = $('toolbar');
  const statsEl = $('stats');

  let peer = null; // eigene PeerJS-Verbindung
  let conn = null; // Datenkanal für Anmeldung + Steuerung
  let call = null; // Videoverbindung
  let pc = null; // RTCPeerConnection des Videos (für Statistik)
  let ending = false;
  let connecting = false;

  // ---------- Hilfsfunktionen ----------
  function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('err', isError);
  }
  function showOverlay(text) {
    overlay.textContent = text;
    overlay.classList.toggle('hidden', !text);
  }
  function formatCode(v) {
    const d = String(v).replace(/\D/g, '').slice(0, 9);
    return d.replace(/(\d{3})(?=\d)/g, '$1 ');
  }
  function sendInput(msg) {
    if (conn && conn.open) conn.send(msg);
  }

  // ---------- Gemerkte Computer (nur Code + Name, nie die PIN) ----------
  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; }
  }
  function storeSaved(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch {}
  }
  function rememberComputer(code, name) {
    const list = loadSaved().filter((c) => c.code !== code);
    list.unshift({ code, name: name || 'Computer' });
    storeSaved(list.slice(0, 10));
  }
  function renderSaved() {
    const box = $('saved');
    const list = loadSaved();
    box.innerHTML = '';
    box.classList.toggle('hidden', !list.length);
    for (const c of list) {
      const item = document.createElement('div');
      item.className = 'saved-item';
      item.title = 'Code übernehmen';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = '🖥 ' + c.name;
      const code = document.createElement('span');
      code.className = 'code';
      code.textContent = formatCode(c.code);
      const del = document.createElement('button');
      del.className = 'del';
      del.type = 'button';
      del.title = 'Entfernen';
      del.textContent = '✕';
      del.onclick = (e) => {
        e.stopPropagation();
        storeSaved(loadSaved().filter((x) => x.code !== c.code));
        renderSaved();
      };
      item.onclick = () => {
        codeInput.value = formatCode(c.code);
        pinInput.focus();
      };
      item.append(name, code, del);
      box.appendChild(item);
    }
  }

  codeInput.addEventListener('input', () => { codeInput.value = formatCode(codeInput.value); });
  pinInput.addEventListener('input', () => { pinInput.value = pinInput.value.replace(/\D/g, ''); });
  const urlCode = new URLSearchParams(location.search).get('code');
  renderSaved();
  if (urlCode) {
    codeInput.value = formatCode(urlCode);
    pinInput.focus();
  } else if (loadSaved().length) {
    codeInput.value = formatCode(loadSaved()[0].code);
    pinInput.focus();
  } else {
    codeInput.focus();
  }

  // ---------- Verbindung aufbauen ----------
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (connecting) return;
    const code = codeInput.value.replace(/\D/g, '');
    const pin = pinInput.value.trim();
    if (code.length !== 9) return setStatus('Der Computer-Code hat 9 Ziffern.', true);
    if (pin.length < 6) return setStatus('Die PIN hat mindestens 6 Ziffern.', true);
    if (typeof Peer === 'undefined') return setStatus('Verbindungsbibliothek konnte nicht geladen werden. Seite neu laden.', true);
    connect(code, pin);
  });

  function failConnect(text) {
    connecting = false;
    connectBtn.disabled = false;
    setStatus(text, true);
    cleanup();
  }

  function connect(code, pin) {
    connecting = true;
    ending = false;
    connectBtn.disabled = true;
    setStatus('Verbinde …');
    cleanup();

    peer = new Peer({ debug: 1 });
    const giveUp = setTimeout(() => {
      if (connecting) failConnect('Keine Antwort. Ist der Computer eingeschaltet und RemoteDesk gestartet?');
    }, 25000);

    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        clearTimeout(giveUp);
        failConnect('Computer nicht erreichbar. Code prüfen – und ob RemoteDesk dort läuft und online ist.');
      } else if (connecting) {
        clearTimeout(giveUp);
        failConnect('Verbindungsfehler: ' + (err.message || err.type));
      }
    });

    peer.on('open', () => {
      const myConn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      conn = myConn;
      conn.on('open', () => {
        setStatus('PIN wird geprüft …');
        conn.send({ t: 'auth', pin });
      });
      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'info') setStatus(msg.msg);
        if (msg.t === 'auth-fail') {
          clearTimeout(giveUp);
          failConnect(msg.msg);
        }
        if (msg.t === 'auth-ok') {
          clearTimeout(giveUp);
          pinInput.value = '';
          $('hostName').textContent = '🖥 ' + (msg.name || '');
          if ($('remember').checked) rememberComputer(code, msg.name);
          renderSaved();
          setStatus('Bild wird geladen …');
        }
      });
      conn.on('close', () => {
        if (conn !== myConn) return; // bereits aufgeräumt (z. B. nach falscher PIN)
        if (connecting) failConnect('Verbindung wurde vom anderen Computer beendet.');
        else endSession('Die Verbindung wurde am anderen Computer beendet.');
      });
    });

    // Der Host ruft nach erfolgreicher Anmeldung mit dem Bildschirm-Video an
    peer.on('call', (incoming) => {
      if (!conn || incoming.peer !== conn.peer) return incoming.close();
      call = incoming;
      call.answer();
      call.on('stream', (stream) => {
        connecting = false;
        video.srcObject = stream;
        connectScreen.classList.add('hidden');
        sessionScreen.classList.remove('hidden');
        showOverlay('');
        setStatus('');
        video.focus();
        pc = call.peerConnection;
        if (pc) {
          pc.addEventListener('connectionstatechange', () => {
            const s = pc && pc.connectionState;
            if (s === 'disconnected') showOverlay('Verbindung unterbrochen – versuche erneut …');
            if (s === 'connected') showOverlay('');
            if (s === 'failed') endSession('Verbindung abgebrochen.');
          });
        }
        startStats();
      });
      const myCall = call;
      call.on('close', () => { if (call === myCall) endSession('Die Verbindung wurde beendet.'); });
    });
  }

  function cleanup() {
    // Erst Variablen leeren: PeerJS meldet 'close' teils synchron beim Schließen
    const c = call, d = conn, p = peer;
    call = null; conn = null; peer = null; pc = null;
    try { c && c.close(); } catch {}
    try { d && d.close(); } catch {}
    try { p && p.destroy(); } catch {}
  }

  function endSession(reason) {
    if (ending) return;
    ending = true;
    connecting = false;
    cleanup();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    video.srcObject = null;
    sessionScreen.classList.add('hidden');
    connectScreen.classList.remove('hidden');
    connectBtn.disabled = false;
    setStatus(reason || 'Sitzung beendet.', !!reason);
    pinInput.focus();
  }

  // ---------- Statistik ----------
  let statsTimer = null;
  let lastBytes = 0, lastTs = 0;
  function startStats() {
    clearInterval(statsTimer);
    statsTimer = setInterval(async () => {
      if (!pc) return clearInterval(statsTimer);
      const report = await pc.getStats();
      report.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          const kbps = lastTs ? ((r.bytesReceived - lastBytes) * 8) / (r.timestamp - lastTs) : 0;
          lastBytes = r.bytesReceived; lastTs = r.timestamp;
          statsEl.textContent = `${r.frameWidth || '?'}×${r.frameHeight || '?'} · ${Math.round(r.framesPerSecond || 0)} fps · ${(kbps / 1000).toFixed(1)} Mbit/s`;
        }
      });
    }, 1000);
  }

  // ---------- Toolbar ----------
  $('toolbarHandle').addEventListener('click', () => toolbar.classList.toggle('hidden'));
  $('leaveBtn').addEventListener('click', () => endSession());
  $('fsBtn').addEventListener('click', toggleFullscreen);
  $('quality').addEventListener('change', (e) => {
    sendInput({ t: 'quality', v: e.target.value });
    video.focus();
  });
  $('combo').addEventListener('change', (e) => {
    if (e.target.value) sendInput({ t: 'combo', keys: e.target.value.split('+') });
    e.target.value = '';
    video.focus();
  });
  $('clipBtn').addEventListener('click', async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch {}
    text = prompt('Text, der in die Zwischenablage des anderen Computers kopiert wird (danach dort mit Strg+V / Cmd+V einfügen):', text);
    if (text) sendInput({ t: 'clipboard', text });
    video.focus();
  });

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await sessionScreen.requestFullscreen({ navigationUI: 'hide' });
    toolbar.classList.add('hidden');
    // Damit auch Esc, Alt+Tab, Windows-Taste usw. an den anderen PC gehen (Chrome/Edge)
    if (navigator.keyboard && navigator.keyboard.lock) {
      try { await navigator.keyboard.lock(); } catch {}
    }
    video.focus();
  }
  document.addEventListener('fullscreenchange', () => {
    $('fsBtn').textContent = document.fullscreenElement ? '⛶ Vollbild beenden' : '⛶ Vollbild';
    if (!document.fullscreenElement && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
  });

  // ---------- Maus ----------
  // Rechnet Bildschirmposition in Koordinaten 0..1 auf dem entfernten Bildschirm um
  // (berücksichtigt schwarze Ränder durch object-fit: contain).
  function toRemote(e) {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(r.width / vw, r.height / vh);
    const w = vw * scale, h = vh * scale;
    const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
    const x = (e.clientX - ox) / w, y = (e.clientY - oy) / h;
    if (x < 0 || y < 0 || x > 1 || y > 1) return null;
    return { x, y };
  }

  let pendingMove = null;
  video.addEventListener('mousemove', (e) => {
    const p = toRemote(e);
    if (!p) return;
    if (!pendingMove) requestAnimationFrame(() => {
      sendInput({ t: 'move', ...pendingMove });
      pendingMove = null;
    });
    pendingMove = p;
  });
  video.addEventListener('mousedown', (e) => {
    e.preventDefault();
    video.focus();
    toolbar.classList.add('hidden');
    const p = toRemote(e);
    if (p) sendInput({ t: 'down', b: e.button, ...p });
  });
  window.addEventListener('mouseup', (e) => {
    if (sessionScreen.classList.contains('hidden')) return;
    const p = toRemote(e) || {};
    sendInput({ t: 'up', b: e.button, ...p });
  });
  video.addEventListener('contextmenu', (e) => e.preventDefault());
  video.addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1; // in Pixel umrechnen
    sendInput({ t: 'wheel', dx: e.deltaX * f, dy: e.deltaY * f });
  }, { passive: false });

  // ---------- Tastatur ----------
  const isMacViewer = /Mac|iPhone|iPad/.test(navigator.platform);
  function keyHandler(e) {
    if (sessionScreen.classList.contains('hidden')) return;
    if (document.activeElement && document.activeElement !== video && document.activeElement !== document.body) return;
    e.preventDefault();
    if (e.type === 'keydown') {
      const altGr = e.getModifierState && e.getModifierState('AltGraph');
      const printable = e.key.length === 1 && (altGr || !(e.ctrlKey || e.metaKey || e.altKey) ||
        (isMacViewer && e.altKey && !e.ctrlKey && !e.metaKey)); // Mac: Option+Taste erzeugt Sonderzeichen
      if (printable) sendInput({ t: 'text', s: e.key });
      else sendInput({ t: 'kd', code: e.code, key: e.key, m: { c: e.ctrlKey, s: e.shiftKey, a: e.altKey, w: e.metaKey } });
    } else {
      sendInput({ t: 'ku', code: e.code, key: e.key });
    }
  }
  window.addEventListener('keydown', keyHandler, true);
  window.addEventListener('keyup', keyHandler, true);
  // Wenn das Fenster den Fokus verliert, alle Tasten am anderen PC loslassen
  window.addEventListener('blur', () => sendInput({ t: 'releaseAll' }));

  window.addEventListener('beforeunload', cleanup);
})();
