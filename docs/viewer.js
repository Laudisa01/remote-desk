// RemoteDesk – Viewer (läuft im Browser des steuernden PCs)
(() => {
  const $ = (id) => document.getElementById(id);
  const PREFIX = 'rdsk-';
  const STORE_KEY = 'remotedesk.computers';
  const CHUNK = 11 * 1024; // PeerJS erlaubt max. ~16 KB pro Nachricht
  const CONTROL_TYPES = new Set(['move', 'down', 'up', 'wheel', 'kd', 'ku', 'text', 'combo', 'clipboard', 'releaseAll', 'screen', 'clip', 'file-start', 'file-chunk', 'file-end', 'file-pick']);
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
  let canControl = true; // false = nur zusehen
  let hostLabel = '';

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
    if (!canControl && CONTROL_TYPES.has(msg.t)) return;
    // Testmodus: Steuerbefehle nur protokollieren statt senden (für automatische Tests)
    const de = document.documentElement;
    if (de.dataset.rdTest === '1' && CONTROL_TYPES.has(msg.t) && !msg.t.startsWith('file') && msg.t !== 'clip') {
      de.dataset.rdLog = (de.dataset.rdLog || '') + msg.t + (msg.b !== undefined ? ':' + msg.b : '') + (msg.t === 'wheel' ? '(' + Math.round(msg.dy) + ')' : '') + (msg.t === 'text' ? '(' + msg.s + ')' : '') + (msg.code ? '(' + msg.code + ')' : '') + ' ';
      return;
    }
    if (conn && conn.open) conn.send(msg);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  const inSession = () => !sessionScreen.classList.contains('hidden');

  // ---------- Hinweise unten (Toasts) ----------
  function toast(id, text, sub, progress, ttl) {
    let el = document.querySelector(`.toast[data-id="${CSS.escape(id)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast glass';
      el.dataset.id = id;
      el.innerHTML = '<div class="t-row"><span class="t-text"></span><span class="t-sub"></span></div><div class="t-bar hidden"><div></div></div>';
      $('toasts').appendChild(el);
    }
    el.querySelector('.t-text').textContent = text;
    el.querySelector('.t-sub').textContent = sub || '';
    el.querySelector('.t-bar').classList.toggle('hidden', progress == null);
    if (progress != null) el.querySelector('.t-bar div').style.width = Math.round(progress * 100) + '%';
    clearTimeout(el._t);
    if (ttl) el._t = setTimeout(() => el.remove(), ttl);
    return el;
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
      name.textContent = c.name;
      const code = document.createElement('span');
      code.className = 'code';
      code.textContent = formatCode(c.code);
      const del = document.createElement('button');
      del.className = 'del';
      del.type = 'button';
      del.title = 'Entfernen';
      del.textContent = '✕';
      del.setAttribute('aria-label', 'Entfernen');
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

  // Eigene zufällige Kennung erzeugen, statt sie beim PeerJS-Server abzufragen
  // (diese Abfrage ist die häufigste Ursache für „server-error“).
  function randomId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return 'rdv-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const RETRYABLE = ['server-error', 'socket-error', 'socket-closed', 'network', 'unavailable-id'];
  const MAX_ATTEMPTS = 4;

  function connect(code, pin, attempt = 1) {
    connecting = true;
    ending = false;
    connectBtn.disabled = true;
    setStatus(attempt === 1 ? 'Verbinde …' : `Verbinde … (Versuch ${attempt} von ${MAX_ATTEMPTS})`);
    cleanup();

    const myPeer = new Peer(randomId(), { debug: 1 });
    peer = myPeer;
    let pinSent = false;
    const giveUp = setTimeout(() => {
      if (connecting && peer === myPeer) failConnect('Keine Antwort. Ist der Computer eingeschaltet und RemoteDesk gestartet?');
    }, 45000);

    myPeer.on('error', (err) => {
      if (peer !== myPeer) return; // veralteter Versuch
      if (err.type === 'peer-unavailable') {
        clearTimeout(giveUp);
        failConnect('Computer nicht erreichbar. Code prüfen – und ob RemoteDesk dort läuft und online ist.');
      } else if (connecting && !pinSent && RETRYABLE.includes(err.type) && attempt < MAX_ATTEMPTS) {
        // Vermittlungsserver kurz nicht erreichbar → automatisch erneut versuchen
        clearTimeout(giveUp);
        cleanup();
        setTimeout(() => { if (connecting) connect(code, pin, attempt + 1); }, 1500 * attempt);
      } else if (connecting) {
        clearTimeout(giveUp);
        if (RETRYABLE.includes(err.type)) {
          failConnect('Der Vermittlungsserver ist von diesem Computer aus nicht erreichbar (Werbeblocker, Virenscanner oder Netzwerkfilter?). ');
          const a = document.createElement('a');
          a.href = 'check.html';
          a.textContent = 'Verbindungstest starten';
          statusEl.appendChild(a);
        } else {
          failConnect('Verbindungsfehler: ' + (err.message || err.type));
        }
      }
    });

    myPeer.on('open', () => {
      if (peer !== myPeer) return;
      const myConn = myPeer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      conn = myConn;
      conn.on('open', () => {
        setStatus('PIN wird geprüft …');
        pinSent = true;
        myConn.send({ t: 'auth', pin, ua: navigator.userAgent });
      });
      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        switch (msg.t) {
          case 'info': setStatus(msg.msg); break;
          case 'screens': renderScreens(msg.list, msg.cur); break;
          case 'auth-fail':
            clearTimeout(giveUp);
            failConnect(msg.msg);
            break;
          case 'auth-ok':
            clearTimeout(giveUp);
            pinInput.value = '';
            hostLabel = msg.name || '';
            $('hostName').textContent = hostLabel;
            setRole(msg.role || 'control');
            if ($('remember').checked) rememberComputer(code, msg.name);
            renderSaved();
            setStatus('Bild wird geladen …');
            break;
          case 'role':
            setRole(msg.role);
            if (msg.role === 'control') toast('role', 'Du steuerst jetzt den Computer.', '', null, 4000);
            break;
          case 'viewers':
            $('hostName').textContent = hostLabel + (msg.n > 1 ? ` · ${msg.n} verbunden` : '');
            break;
          case 'chat': addChat(String(msg.text || ''), false, String(msg.from || hostLabel)); break;
          case 'clip': receiveClip(String(msg.text || '')); break;
          case 'file-start':
          case 'file-chunk':
          case 'file-end':
            receiveFile(msg);
            break;
          case 'file-saved':
            toast('up-' + msg.id, String(msg.name || 'Datei'), 'Gespeichert in „Downloads“', 1, 4000);
            break;
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
        setupAudio(stream);
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
        if (isTouch) toast('touch', 'Ein Finger bewegt die Maus, Tippen klickt.', 'Zwei Finger: scrollen / zoomen', null, 6000);
      });
      const myCall = call;
      call.on('close', () => { if (call === myCall) endSession('Die Verbindung wurde beendet.'); });
    });
  }

  function setRole(role) {
    canControl = role !== 'view';
    document.body.classList.toggle('viewonly', !canControl);
    $('roleBadge').classList.toggle('hidden', canControl);
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
    if (recorder) stopRecording();
    cleanup();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    video.srcObject = null;
    setZoom(1);
    incomingFiles.clear();
    $('toasts').innerHTML = '';
    $('chatLog').innerHTML = '<p class="chat-empty">Schreib der Person am anderen Computer.</p>';
    $('chatPanel').classList.add('hidden');
    $('chatBadge').classList.add('hidden');
    setRole('control');
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

  // ---------- Ton ----------
  const soundBtn = $('soundBtn');
  async function setupAudio(stream) {
    const has = stream.getAudioTracks().length > 0;
    soundBtn.classList.toggle('hidden', !has);
    if (!has) return;
    video.muted = false;
    try { await video.play(); } catch { video.muted = true; }
    soundBtn.classList.toggle('muted', video.muted);
  }
  soundBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    video.play().catch(() => {});
    soundBtn.classList.toggle('muted', video.muted);
    video.focus();
  });

  // ---------- Bildschirmauswahl (bei mehreren Monitoren) ----------
  const screenSel = $('screenSel');
  function renderScreens(list, cur) {
    list = Array.isArray(list) ? list : [];
    screenSel.innerHTML = '';
    list.forEach((s) => {
      const o = document.createElement('option');
      o.value = String(s.id);
      o.textContent = String(s.label || s.id);
      screenSel.appendChild(o);
    });
    screenSel.value = String(cur || '');
    screenSel.disabled = false;
    screenSel.classList.toggle('hidden', list.length < 2);
  }
  screenSel.addEventListener('change', () => {
    screenSel.disabled = true; // bis der andere Computer gewechselt hat
    sendInput({ t: 'screen', id: screenSel.value });
    video.focus();
  });

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

  async function toggleFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    const req = sessionScreen.requestFullscreen || sessionScreen.webkitRequestFullscreen;
    if (!req) return toast('fs', 'Vollbild wird von diesem Browser nicht unterstützt.', '', null, 3000);
    try { await req.call(sessionScreen, { navigationUI: 'hide' }); } catch { return; }
    toolbar.classList.add('hidden');
    // Damit auch Esc, Alt+Tab, Windows-Taste usw. an den anderen PC gehen (Chrome/Edge)
    if (navigator.keyboard && navigator.keyboard.lock) {
      try { await navigator.keyboard.lock(); } catch {}
    }
    video.focus();
  }
  document.addEventListener('fullscreenchange', () => {
    $('fsBtn').querySelector('.lbl').textContent = document.fullscreenElement ? 'Vollbild beenden' : 'Vollbild';
    if (!document.fullscreenElement && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
  });

  // ---------- Chat ----------
  const chatPanel = $('chatPanel');
  function addChat(text, mine, who) {
    if (!text) return;
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
    if (!mine && chatPanel.classList.contains('hidden')) {
      $('chatBadge').classList.remove('hidden');
      toast('chat', `${who}: ${text}`, '', null, 5000).onclick = openChat;
    }
  }
  function openChat() {
    chatPanel.classList.remove('hidden');
    $('chatBadge').classList.add('hidden');
    const t = document.querySelector('.toast[data-id="chat"]');
    if (t) t.remove();
    $('chatInput').focus();
  }
  $('chatBtn').addEventListener('click', () => (chatPanel.classList.contains('hidden') ? openChat() : chatPanel.classList.add('hidden')));
  $('chatClose').addEventListener('click', () => { chatPanel.classList.add('hidden'); video.focus(); });
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text || !conn || !conn.open) return;
    conn.send({ t: 'chat', text });
    addChat(text, true);
    $('chatInput').value = '';
  });
  $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') { chatPanel.classList.add('hidden'); video.focus(); } });

  // ---------- Zwischenablage automatisch abgleichen ----------
  let lastClip = '';
  let pendingClip = null;
  async function receiveClip(text) {
    lastClip = text;
    try { await navigator.clipboard.writeText(text); pendingClip = null; }
    catch { pendingClip = text; } // geht nur, wenn dieses Fenster aktiv ist
  }
  async function pushClip() {
    if (!canControl || !inSession() || !navigator.clipboard || !navigator.clipboard.readText) return;
    try {
      const t = await Promise.race([navigator.clipboard.readText(), sleep(400).then(() => null)]);
      if (t != null && t !== lastClip && t.length <= 15000) {
        lastClip = t;
        sendInput({ t: 'clip', text: t });
      }
    } catch {}
  }
  window.addEventListener('focus', () => {
    if (pendingClip != null) receiveClip(pendingClip);
    else pushClip();
  });

  // ---------- Dateien ----------
  function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  async function sendFiles(files) {
    if (!canControl) return;
    for (const file of files) {
      if (!conn || !conn.open) break;
      const id = Math.random().toString(16).slice(2) + Date.now().toString(16);
      const tid = 'up-' + id;
      toast(tid, file.name, 'Wird gesendet …', 0);
      conn.send({ t: 'file-start', id, name: file.name, size: file.size });
      let offset = 0;
      let ok = true;
      while (offset < file.size) {
        if (!conn || !conn.open) { ok = false; break; }
        const buf = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
        const dc = conn.dataChannel;
        while (dc && dc.bufferedAmount > 2 * 1024 * 1024) await sleep(25);
        conn.send({ t: 'file-chunk', id, data: bytesToB64(buf) });
        offset += buf.length;
        toast(tid, file.name, `${fmtSize(offset)} von ${fmtSize(file.size)}`, offset / file.size);
      }
      if (conn && conn.open) conn.send({ t: 'file-end', id, abort: !ok });
      if (!ok) toast(tid, file.name, 'Abgebrochen', null, 4000);
      else if (!file.size) toast(tid, file.name, 'Gesendet', 1, 4000);
    }
  }
  const incomingFiles = new Map();
  function receiveFile(msg) {
    const id = String(msg.id || '');
    const tid = 'down-' + id;
    if (msg.t === 'file-start') {
      incomingFiles.set(id, { name: String(msg.name || 'Datei'), size: Number(msg.size) || 0, parts: [], got: 0 });
      toast(tid, String(msg.name || 'Datei'), 'Wird empfangen …', 0);
      return;
    }
    const f = incomingFiles.get(id);
    if (!f) return;
    if (msg.t === 'file-chunk') {
      const bytes = b64ToBytes(String(msg.data || ''));
      f.parts.push(bytes);
      f.got += bytes.length;
      toast(tid, f.name, `${fmtSize(f.got)} von ${fmtSize(f.size)}`, f.size ? f.got / f.size : 0);
    } else {
      incomingFiles.delete(id);
      if (msg.abort) return toast(tid, f.name, 'Abgebrochen', null, 4000);
      const url = URL.createObjectURL(new Blob(f.parts));
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast(tid, f.name, 'Heruntergeladen', 1, 4000);
    }
  }
  $('sendFileBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    sendFiles(files);
    video.focus();
  });
  $('getFileBtn').addEventListener('click', () => {
    sendInput({ t: 'file-pick' });
    toast('pick', 'Wähle die Datei im Fenster auf dem anderen Computer aus.', '', null, 5000);
    video.focus();
  });
  // Drag & Drop ins Fenster
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!inSession() || !canControl || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    $('dropZone').classList.remove('hidden');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropZone').classList.add('hidden');
  });
  window.addEventListener('dragover', (e) => { if (inSession()) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!inSession()) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropZone').classList.add('hidden');
    if (e.dataTransfer && e.dataTransfer.files.length) sendFiles([...e.dataTransfer.files]);
  });

  // ---------- Aufnahme ----------
  let recorder = null;
  let recChunks = [];
  function startRecording() {
    if (!video.srcObject || typeof MediaRecorder === 'undefined') return toast('rec', 'Aufnahme wird von diesem Browser nicht unterstützt.', '', null, 4000);
    const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    recChunks = [];
    recorder = new MediaRecorder(video.srcObject, type ? { mimeType: type, videoBitsPerSecond: 8_000_000 } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => {
      const mime = recorder ? recorder.mimeType : 'video/webm';
      const blob = new Blob(recChunks, { type: mime });
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const name = `RemoteDesk-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${mime.includes('mp4') ? 'mp4' : 'webm'}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      recorder = null;
    };
    recorder.start(1000);
    $('recBtn').classList.add('on');
    if (conn && conn.open) conn.send({ t: 'rec', on: true });
    toast('rec', 'Aufnahme läuft', 'Der andere Computer sieht einen Hinweis', null, 3000);
  }
  function stopRecording() {
    if (!recorder) return;
    try { recorder.stop(); } catch {}
    $('recBtn').classList.remove('on');
    if (conn && conn.open) conn.send({ t: 'rec', on: false });
    toast('rec', 'Aufnahme gespeichert', 'im Download-Ordner', null, 3000);
  }
  $('recBtn').addEventListener('click', () => { recorder ? stopRecording() : startRecording(); video.focus(); });

  // ---------- Lupe / Zoom ----------
  let zoom = 1;
  let originX = 0, originY = 0;
  function applyZoom() {
    if (zoom <= 1.001) {
      video.style.transform = '';
    } else {
      video.style.transformOrigin = `${originX}px ${originY}px`;
      video.style.transform = `scale(${zoom})`;
    }
    $('zoomLbl').textContent = (Math.round(zoom * 10) / 10).toString().replace('.', ',') + '×';
  }
  function setZoom(z, ox, oy) {
    zoom = Math.min(4, Math.max(1, z));
    if (ox != null) { originX = ox; originY = oy; }
    applyZoom();
  }
  function setOrigin(clientX, clientY) {
    const r = sessionScreen.getBoundingClientRect();
    originX = clientX - r.left;
    originY = clientY - r.top;
    if (zoom > 1) video.style.transformOrigin = `${originX}px ${originY}px`;
  }
  $('zoomBtn').addEventListener('click', () => {
    const steps = [1, 1.5, 2, 3];
    const next = steps.find((s) => s > zoom + 0.01) || 1;
    const r = sessionScreen.getBoundingClientRect();
    if (zoom <= 1) { originX = r.width / 2; originY = r.height / 2; }
    setZoom(next);
    video.focus();
  });

  // ---------- Maus ----------
  // Rechnet Bildschirmposition in Koordinaten 0..1 auf dem entfernten Bildschirm um
  // (berücksichtigt schwarze Ränder durch object-fit: contain und die Lupe).
  function contentRect() {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(r.width / vw, r.height / vh);
    const w = vw * scale, h = vh * scale;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, w, h };
  }
  function toRemote(e) {
    const c = contentRect();
    if (!c) return null;
    const x = (e.clientX - c.left) / c.w, y = (e.clientY - c.top) / c.h;
    if (x < 0 || y < 0 || x > 1 || y > 1) return null;
    return { x, y };
  }

  let pendingMove = null;
  function queueMove(p) {
    if (!pendingMove) requestAnimationFrame(() => {
      sendInput({ t: 'move', ...pendingMove });
      pendingMove = null;
    });
    pendingMove = p;
  }
  video.addEventListener('mousemove', (e) => {
    if (zoom > 1) setOrigin(e.clientX, e.clientY); // Lupe folgt der Maus
    const p = toRemote(e);
    if (p) queueMove(p);
  });
  video.addEventListener('mousedown', (e) => {
    e.preventDefault();
    video.focus();
    toolbar.classList.add('hidden');
    const p = toRemote(e);
    if (p) sendInput({ t: 'down', b: e.button, ...p });
  });
  window.addEventListener('mouseup', (e) => {
    if (!inSession()) return; // auch außerhalb loslassen, sonst bleibt die Taste hängen
    const p = toRemote(e) || {};
    sendInput({ t: 'up', b: e.button, ...p });
  });
  video.addEventListener('contextmenu', (e) => e.preventDefault());
  video.addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1; // in Pixel umrechnen
    sendInput({ t: 'wheel', dx: e.deltaX * f, dy: e.deltaY * f });
  }, { passive: false });

  // ---------- Handy / Tablet: Trackpad-Steuerung ----------
  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  if (isTouch) $('kbdBtn').classList.remove('hidden');
  let cur = { x: 0.5, y: 0.5 };
  let t1 = null; // ein Finger: { x, y, t, moved, dragging, timer }
  let t2 = null; // zwei Finger: { dist, mid, z0, t, moved, pinch }
  function curClient() {
    const c = contentRect();
    return c ? { x: c.left + cur.x * c.w, y: c.top + cur.y * c.h } : null;
  }
  function touchDist(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
  function touchMid(a, b) { return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }; }
  function clickAt(b) {
    sendInput({ t: 'down', b, ...cur });
    sendInput({ t: 'up', b, ...cur });
  }
  video.addEventListener('touchstart', (e) => {
    e.preventDefault();
    toolbar.classList.add('hidden');
    if (e.touches.length === 1) {
      const t = e.touches[0];
      t1 = { x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, t: Date.now(), moved: false, dragging: false };
      t1.timer = setTimeout(() => {
        if (t1 && !t1.moved) { // lange drücken = Maustaste halten (zum Ziehen)
          t1.dragging = true;
          sendInput({ t: 'down', b: 0, ...cur });
          if (navigator.vibrate) navigator.vibrate(15);
        }
      }, 450);
      t2 = null;
    } else if (e.touches.length === 2) {
      if (t1) clearTimeout(t1.timer);
      if (t1 && t1.dragging) sendInput({ t: 'up', b: 0, ...cur });
      t1 = null;
      const [a, b] = e.touches;
      t2 = { dist: touchDist(a, b), mid: touchMid(a, b), z0: zoom, t: Date.now(), moved: false, pinch: false };
    }
  }, { passive: false });
  video.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const c = contentRect();
    if (!c) return;
    if (t1 && e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - t1.x, dy = t.clientY - t1.y;
      t1.x = t.clientX; t1.y = t.clientY;
      if (Math.hypot(t.clientX - t1.sx, t.clientY - t1.sy) > 8) { t1.moved = true; if (!t1.dragging) clearTimeout(t1.timer); }
      if (!t1.moved) return;
      const speed = 1.3;
      cur = { x: Math.min(1, Math.max(0, cur.x + (dx * speed) / c.w)), y: Math.min(1, Math.max(0, cur.y + (dy * speed) / c.h)) };
      queueMove(cur);
      if (zoom > 1) { const p = curClient(); if (p) setOrigin(p.x, p.y); }
    } else if (t2 && e.touches.length === 2) {
      const [a, b] = e.touches;
      const dist = touchDist(a, b), mid = touchMid(a, b);
      const ratio = dist / t2.dist;
      if (!t2.pinch && Math.abs(ratio - 1) > 0.12) t2.pinch = true;
      if (t2.pinch) {
        setOrigin(mid.x, mid.y);
        setZoom(t2.z0 * ratio);
      } else {
        const dy = mid.y - t2.mid.y, dx = mid.x - t2.mid.x;
        if (Math.abs(dy) > 2 || Math.abs(dx) > 2) {
          t2.moved = true;
          sendInput({ t: 'wheel', dx: -dx * 2.5, dy: -dy * 2.5 });
          t2.mid = mid;
        }
      }
    }
  }, { passive: false });
  video.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (t1 && e.touches.length === 0) {
      clearTimeout(t1.timer);
      if (t1.dragging) sendInput({ t: 'up', b: 0, ...cur });
      else if (!t1.moved && Date.now() - t1.t < 300) clickAt(0); // tippen = klicken
      t1 = null;
    }
    if (t2 && e.touches.length < 2) {
      if (!t2.moved && !t2.pinch && Date.now() - t2.t < 300) clickAt(2); // mit zwei Fingern tippen = Rechtsklick
      t2 = null;
    }
  }, { passive: false });

  // Bildschirmtastatur
  const kbdInput = $('kbdInput');
  $('kbdBtn').addEventListener('click', () => {
    kbdInput.value = '';
    kbdInput.focus();
  });
  kbdInput.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText' || e.inputType === 'insertCompositionText') {
      if (e.data) sendInput({ t: 'text', s: e.data });
    } else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      sendInput({ t: 'kd', code: 'Enter', key: 'Enter', m: {} });
      sendInput({ t: 'ku', code: 'Enter', key: 'Enter' });
    } else if (e.inputType.startsWith('deleteContentBackward')) {
      sendInput({ t: 'kd', code: 'Backspace', key: 'Backspace', m: {} });
      sendInput({ t: 'ku', code: 'Backspace', key: 'Backspace' });
    }
  });
  kbdInput.addEventListener('keydown', (e) => {
    const special = ['Escape', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (special.includes(e.key)) {
      e.preventDefault();
      sendInput({ t: 'kd', code: e.key === 'Escape' ? 'Escape' : e.key === 'Tab' ? 'Tab' : e.key, key: e.key, m: {} });
      sendInput({ t: 'ku', code: e.key === 'Escape' ? 'Escape' : e.key === 'Tab' ? 'Tab' : e.key, key: e.key });
    }
  });

  // ---------- Tastatur ----------
  const isMacViewer = /Mac|iPhone|iPad/.test(navigator.platform);
  let keyChain = Promise.resolve(); // Reihenfolge der Tasten sicherstellen
  function keyHandler(e) {
    if (!inSession()) return;
    if (document.activeElement && document.activeElement !== video && document.activeElement !== document.body) return;
    e.preventDefault();
    const ev = { type: e.type, code: e.code, key: e.key, c: e.ctrlKey, s: e.shiftKey, a: e.altKey, w: e.metaKey,
      altGr: e.getModifierState && e.getModifierState('AltGraph') };
    const isPaste = ev.type === 'keydown' && ev.code === 'KeyV' && (ev.c || ev.w);
    keyChain = keyChain.then(async () => {
      if (isPaste) await pushClip(); // eigene Zwischenablage vor dem Einfügen rüberschicken
      if (ev.type === 'keydown') {
        const printable = ev.key.length === 1 && (ev.altGr || !(ev.c || ev.w || ev.a) ||
          (isMacViewer && ev.a && !ev.c && !ev.w)); // Mac: Option+Taste erzeugt Sonderzeichen
        if (printable) sendInput({ t: 'text', s: ev.key });
        else sendInput({ t: 'kd', code: ev.code, key: ev.key, m: { c: ev.c, s: ev.s, a: ev.a, w: ev.w } });
      } else {
        sendInput({ t: 'ku', code: ev.code, key: ev.key });
      }
    });
  }
  window.addEventListener('keydown', keyHandler, true);
  window.addEventListener('keyup', keyHandler, true);
  // Wenn das Fenster den Fokus verliert, alle Tasten am anderen PC loslassen
  window.addEventListener('blur', () => sendInput({ t: 'releaseAll' }));

  window.addEventListener('beforeunload', cleanup);
})();
