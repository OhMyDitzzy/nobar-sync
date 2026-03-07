const S = {
  peer: null,
  isHost: false,
  myName: 'Anonim',
  roomCode: null,
  allowViewerControl: false,
  connections: [],
  hostDataConn: null,
  isSyncing: false,
  pendingFile: null,
  pendingModalFile: null,
  modalTab: 'url',
  controlTimer: null,
  // video source (host stores these to send to late-joining viewers)
  videoKind: null,   // 'url' | 'file'
  videoUrl: null,
  fileBuffer: null,
  fileMime: '',
  fileName: '',
  // viewer file reception
  rxChunks: [],
  rxTotal: 0,
  rxReceived: 0,
};

const video = document.getElementById('video-player');
const CHUNK_SIZE = 65536; // 64 KB per chunk

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modal-file-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) {
      S.pendingModalFile = f;
      document.getElementById('modal-file-name').textContent = '✔ ' + f.name;
    }
  });

  document.getElementById('modal-change-video').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  const setupZone = document.getElementById('setup-file-zone');
  ['dragover', 'dragenter'].forEach(ev =>
    setupZone.addEventListener(ev, e => { e.preventDefault(); setupZone.classList.add('drag-over'); })
  );
  ['dragleave', 'dragend', 'drop'].forEach(ev =>
    setupZone.addEventListener(ev, e => { e.preventDefault(); setupZone.classList.remove('drag-over'); })
  );
  setupZone.addEventListener('drop', e => handleSetupFile(e.dataTransfer.files[0]));
});

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function fmtTime(s) {
  if (!s || isNaN(s) || !isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

let toastTimer;
function showToast(msg, dur = 2800) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), dur);
}

function showConnecting(msg = 'Menghubungkan...') {
  document.getElementById('connecting-txt').textContent = msg;
  document.getElementById('connecting').classList.remove('hidden');
}

function hideConnecting() {
  document.getElementById('connecting').classList.add('hidden');
}

function copyCode() {
  if (!S.roomCode) return;
  navigator.clipboard?.writeText(S.roomCode).then(() => showToast('📋 Kode disalin: ' + S.roomCode));
}

function updateViewerBadge(n) {
  document.getElementById('viewers-badge').textContent = n + ' penonton';
  document.getElementById('chat-viewers-badge').textContent = n;
}

function switchSetupTab(tab) {
  document.getElementById('tab-url').classList.toggle('active', tab === 'url');
  document.getElementById('tab-file').classList.toggle('active', tab === 'file');
  document.getElementById('setup-panel-url').classList.toggle('active', tab === 'url');
  document.getElementById('setup-panel-file').classList.toggle('active', tab === 'file');
}

function handleSetupFile(file) {
  if (!file) return;
  S.pendingFile = file;
  document.getElementById('setup-file-name').textContent = '✔ ' + file.name;
}

// ── HOST: CREATE ROOM ────────────────────────

function createRoom() {
  const name = document.getElementById('host-name').value.trim() || 'Host';
  const allowCtrl = document.getElementById('toggle-viewer-ctrl').checked;
  const urlVal = document.getElementById('setup-video-url').value.trim();
  const hasFile = !!S.pendingFile;
  const hasUrl = !!urlVal;

  if (!hasFile && !hasUrl) {
    showToast('⚠️ Pilih file video atau masukkan URL terlebih dahulu');
    return;
  }

  S.myName = name;
  S.allowViewerControl = allowCtrl;
  S.isHost = true;

  showConnecting('Membuat room...');
  initHostPeer(genCode(), urlVal, hasFile);
}

function initHostPeer(code, urlVal, hasFile) {
  if (S.peer) S.peer.destroy();
  S.peer = new Peer(code);

  S.peer.on('open', async (id) => {
    S.roomCode = id;

    if (hasFile && S.pendingFile) {
      await hostLoadFile(S.pendingFile);
    } else if (urlVal) {
      await hostLoadUrl(urlVal);
    }

    hideConnecting();
    showScreen('watch');
    setupWatchUI(true);
  });

  S.peer.on('error', (err) => {
    hideConnecting();
    if (err.type === 'unavailable-id') {
      initHostPeer(genCode(), urlVal, hasFile);
    } else {
      showToast('❌ Error: ' + err.message);
    }
  });

  S.peer.on('connection', (conn) => handleNewViewer(conn));
}

async function hostLoadFile(file) {
  showConnecting('Membaca file...');
  S.videoKind = 'file';
  S.fileMime = file.type || 'video/mp4';
  S.fileName = file.name;
  S.fileBuffer = await file.arrayBuffer();

  const blob = new Blob([S.fileBuffer], { type: S.fileMime });
  video.src = URL.createObjectURL(blob);
  video.srcObject = null;
  await waitForMetadata();
  document.getElementById('video-placeholder').style.display = 'none';
}

async function hostLoadUrl(url) {
  S.videoKind = 'url';
  S.videoUrl = url;
  video.src = url;
  video.srcObject = null;
  video.load();
  await waitForMetadata().catch(() => {});
  document.getElementById('video-placeholder').style.display = 'none';
}

function waitForMetadata() {
  return new Promise((res, rej) => {
    if (video.readyState >= 1) { res(); return; }
    const ok = () => { cleanup(); res(); };
    const err = () => { cleanup(); rej(); };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', ok);
      video.removeEventListener('error', err);
    };
    video.addEventListener('loadedmetadata', ok);
    video.addEventListener('error', err);
    setTimeout(res, 5000);
  });
}

// ── HOST: VIEWER MANAGEMENT ──────────────────

function handleNewViewer(conn) {
  S.connections.push(conn);

  conn.on('open', () => {
    // Send initial state
    conn.send({
      type: 'init',
      allowViewerControl: S.allowViewerControl,
      roomCode: S.roomCode,
      currentTime: video.currentTime,
      paused: video.paused,
      videoKind: S.videoKind,
      videoUrl: S.videoKind === 'url' ? S.videoUrl : null,
      fileMime: S.fileMime,
      fileName: S.fileName,
    });

    // If file-based, transfer the file to this viewer
    if (S.videoKind === 'file' && S.fileBuffer) {
      sendFileTo(conn);
    }

    const name = conn.metadata?.name || 'Penonton';
    const sysMsg = `${name} bergabung 👋`;
    broadcastData({ type: 'sys', msg: sysMsg }, conn);
    addSysMsg(sysMsg);
    updateViewerBadge(S.connections.length);
  });

  conn.on('data', (data) => handleViewerData(conn, data));

  conn.on('close', () => {
    S.connections = S.connections.filter(c => c !== conn);
    updateViewerBadge(S.connections.length);
    const name = conn.metadata?.name || 'Penonton';
    const msg = `${name} keluar`;
    broadcastData({ type: 'sys', msg });
    addSysMsg(msg);
  });

  conn.on('error', () => {
    S.connections = S.connections.filter(c => c !== conn);
    updateViewerBadge(S.connections.length);
  });
}

// Send file in chunks to a specific connection
async function sendFileTo(conn) {
  const buf = S.fileBuffer;
  const total = Math.ceil(buf.byteLength / CHUNK_SIZE);

  conn.send({ type: 'file-start', total, mime: S.fileMime, name: S.fileName });

  for (let i = 0; i < total; i++) {
    if (!conn.open) break;
    const chunk = buf.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    conn.send({ type: 'file-chunk', index: i, data: chunk });
    // Yield every 20 chunks to avoid overwhelming the data channel
    if (i % 20 === 19) await new Promise(r => setTimeout(r, 15));
  }

  conn.send({ type: 'file-end' });
}

function handleViewerData(conn, data) {
  switch (data.type) {
    case 'request-sync':
      handleViewerSync(conn);
      break;
    case 'chat':
      broadcastData({ type: 'chat', name: data.name, text: data.text }, conn);
      addChatMsg({ name: data.name, text: data.text, mine: false, isHost: false });
      break;
    case 'play':
      if (S.allowViewerControl) {
        S.isSyncing = true;
        video.currentTime = data.time;
        video.play().finally(() => S.isSyncing = false);
        broadcastData({ type: 'play', time: data.time }, conn);
      }
      break;
    case 'pause':
      if (S.allowViewerControl) {
        S.isSyncing = true;
        video.currentTime = data.time;
        video.pause();
        S.isSyncing = false;
        broadcastData({ type: 'pause', time: data.time }, conn);
      }
      break;
    case 'seek':
      if (S.allowViewerControl) {
        S.isSyncing = true;
        video.currentTime = data.time;
        S.isSyncing = false;
        broadcastData({ type: 'seek', time: data.time }, conn);
      }
      break;
  }
}

function broadcastData(data, exclude = null) {
  S.connections.forEach(c => {
    if (c !== exclude && c.open) {
      try { c.send(data); } catch (e) {}
    }
  });
}

// ── VIEWER: JOIN ROOM ────────────────────────

function joinRoom() {
  const name = document.getElementById('viewer-name').value.trim() || 'Penonton';
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();

  if (code.length < 4) {
    showToast('⚠️ Masukkan kode room yang valid');
    return;
  }

  S.myName = name;
  S.isHost = false;

  showConnecting('Menghubungkan ke room ' + code + '...');

  if (S.peer) S.peer.destroy();
  S.peer = new Peer(undefined, { debug: 0 });

  S.peer.on('open', () => {
    S.hostDataConn = S.peer.connect(code, { metadata: { name }, reliable: true });

    S.hostDataConn.on('open', () => {
      // Connection open, waiting for 'init' from host
    });

    S.hostDataConn.on('data', handleHostData);

    S.hostDataConn.on('close', () => showToast('❌ Host memutus koneksi'));
    S.hostDataConn.on('error', (e) => {
      hideConnecting();
      showToast('Gagal terhubung: ' + (e.message || e));
    });

    setTimeout(() => {
      if (document.getElementById('screen-watch').style.display === 'none' ||
          !document.getElementById('screen-watch').classList.contains('active')) {
        hideConnecting();
        showToast('⏱ Timeout. Periksa kode room.');
        showScreen('join');
      }
    }, 20000);
  });

  S.peer.on('error', (err) => {
    hideConnecting();
    if (err.type === 'peer-unavailable') {
      showToast('❌ Room tidak ditemukan: ' + code);
    } else {
      showToast('❌ ' + err.message);
    }
    showScreen('join');
  });
}

// ── VIEWER: HANDLE HOST DATA ─────────────────

function handleHostData(data) {
  switch (data.type) {
    case 'init':
      S.allowViewerControl = data.allowViewerControl;
      S.roomCode = data.roomCode;
      document.getElementById('topbar-code').textContent = data.roomCode || '------';

      if (data.videoKind === 'url') {
        // Load URL directly — same as host
        viewerLoadUrl(data.videoUrl, data.currentTime, data.paused);
      } else if (data.videoKind === 'file') {
        // File will arrive via file-start/chunk/end messages
        showConnecting('Menerima video dari host...');
        S.rxChunks = [];
        S.rxTotal = 0;
        S.rxReceived = 0;
      }
      break;

    case 'file-start':
      S.rxChunks = new Array(data.total);
      S.rxTotal = data.total;
      S.rxReceived = 0;
      S.fileMime = data.mime;
      document.getElementById('connecting-txt').textContent =
        `Menerima video... 0%`;
      break;

    case 'file-chunk':
      S.rxChunks[data.index] = data.data;
      S.rxReceived++;
      const pct = Math.round((S.rxReceived / S.rxTotal) * 100);
      document.getElementById('connecting-txt').textContent =
        `Menerima video... ${pct}%`;
      break;

    case 'file-end': {
      const blob = new Blob(S.rxChunks, { type: S.fileMime });
      const blobUrl = URL.createObjectURL(blob);
      video.src = blobUrl;
      video.load();

      hideConnecting();
      showScreen('watch');
      setupWatchUI(false);
      updateControlsAccess();

      function onFileReady() {
        document.getElementById('video-placeholder').style.display = 'none';
        S.hostDataConn.send({ type: 'request-sync' });
      }

      if (video.readyState >= 3) {
        onFileReady();
      } else {
        video.addEventListener('canplay', onFileReady, { once: true });
        video.addEventListener('loadeddata', onFileReady, { once: true });
      }
      break;
    }

    case 'sync':
      // Host responds to request-sync with current playback state
      S.isSyncing = true;
      video.currentTime = data.currentTime;
      S.isSyncing = false;
      if (!data.paused) {
        video.play().catch(() => {});
      }
      break;

    case 'play':
      document.getElementById('video-placeholder').style.display = 'none';
      S.isSyncing = true;
      video.currentTime = data.time;
      video.play().finally(() => S.isSyncing = false);
      break;

    case 'pause':
      S.isSyncing = true;
      video.currentTime = data.time;
      video.pause();
      S.isSyncing = false;
      break;

    case 'seek':
      S.isSyncing = true;
      video.currentTime = data.time;
      S.isSyncing = false;
      break;

    case 'ended':
      document.getElementById('btn-play-pause').textContent = '▶';
      document.getElementById('center-play').textContent = '▶';
      break;

    case 'chat':
      addChatMsg({ name: data.name, text: data.text, mine: false, isHost: data.isHost });
      break;

    case 'sys':
      addSysMsg(data.msg);
      break;

    case 'config-update':
      S.allowViewerControl = data.allowViewerControl;
      updateControlsAccess();
      addSysMsg(data.allowViewerControl
        ? '✅ Semua penonton kini bisa kontrol video'
        : '🔒 Kontrol dikunci ke host saja'
      );
      break;

    case 'video-change':
      // Host changed the video entirely
      addSysMsg('🎬 Host mengganti video...');
      if (data.videoKind === 'url') {
        viewerLoadUrl(data.videoUrl, 0, true);
      } else {
        showConnecting('Menerima video baru...');
        S.rxChunks = [];
        S.rxTotal = 0;
        S.rxReceived = 0;
      }
      break;
  }
}

// Host responds to viewer's request-sync
function handleViewerSync(conn) {
  conn.send({
    type: 'sync',
    currentTime: video.currentTime,
    paused: video.paused,
  });
}

function viewerLoadUrl(url, currentTime, paused) {
  video.src = url;
  video.load();

  // Go to watch screen immediately — don't wait for canplay
  // because host may send play/pause before it fires
  hideConnecting();
  showScreen('watch');
  setupWatchUI(false);
  updateControlsAccess();

  function onReady() {
    document.getElementById('video-placeholder').style.display = 'none';
    S.isSyncing = true;
    video.currentTime = currentTime || 0;
    S.isSyncing = false;
    if (!paused) video.play().catch(() => {});
  }

  // Fire as soon as we have enough data; fall back to loadeddata
  if (video.readyState >= 3) {
    onReady();
  } else {
    video.addEventListener('canplay', onReady, { once: true });
    video.addEventListener('loadeddata', onReady, { once: true });
  }
}

// ── WATCH SCREEN SETUP ───────────────────────

function setupWatchUI(isHost) {
  document.getElementById('topbar-code').textContent = S.roomCode || '------';
  document.getElementById('host-bar').style.display = isHost ? 'flex' : 'none';
  document.getElementById('toggle-ctrl-live').checked = S.allowViewerControl;

  if (isHost) updateViewerBadge(0);

  setupVideoEvents();
  updateControlsAccess();
  showControlsFor(3000);
  addSysMsg(isHost
    ? '🎬 Room dibuat. Bagikan kode ke teman!'
    : '👋 Bergabung ke room ' + S.roomCode
  );
}

function updateControlsAccess() {
  const canControl = S.isHost || S.allowViewerControl;
  document.getElementById('seek-bar').disabled = !canControl;
  document.getElementById('btn-play-pause').disabled = !canControl;
  document.querySelectorAll('.vc-btn:not([onclick*="fullscreen"]):not([onclick*="vol"])').forEach(b => {
    b.disabled = !canControl;
  });
}

function updateViewerControlLive() {
  S.allowViewerControl = document.getElementById('toggle-ctrl-live').checked;
  broadcastData({ type: 'config-update', allowViewerControl: S.allowViewerControl });
  updateControlsAccess();
}

// ── VIDEO EVENTS ─────────────────────────────

function setupVideoEvents() {
  video.addEventListener('play', () => {
    document.getElementById('btn-play-pause').textContent = '⏸';
    document.getElementById('center-play').textContent = '⏸';
    if (S.isHost && !S.isSyncing) {
      broadcastData({ type: 'play', time: video.currentTime });
    } else if (!S.isHost && S.allowViewerControl && !S.isSyncing && S.hostDataConn?.open) {
      S.hostDataConn.send({ type: 'play', time: video.currentTime });
    }
  });

  video.addEventListener('pause', () => {
    document.getElementById('btn-play-pause').textContent = '▶';
    document.getElementById('center-play').textContent = '▶';
    if (S.isHost && !S.isSyncing) {
      broadcastData({ type: 'pause', time: video.currentTime });
    } else if (!S.isHost && S.allowViewerControl && !S.isSyncing && S.hostDataConn?.open) {
      S.hostDataConn.send({ type: 'pause', time: video.currentTime });
    }
  });

  video.addEventListener('ended', () => {
    document.getElementById('btn-play-pause').textContent = '▶';
    document.getElementById('center-play').textContent = '▶';
    if (S.isHost) broadcastData({ type: 'ended' });
  });

  video.addEventListener('timeupdate', () => {
    const dur = video.duration;
    const pct = dur && isFinite(dur) ? (video.currentTime / dur) * 100 : 0;
    const sb = document.getElementById('seek-bar');
    sb.value = pct;
    sb.style.background = `linear-gradient(to right, var(--gold) ${pct}%, rgba(255,255,255,.2) ${pct}%)`;
    document.getElementById('time-display').textContent =
      fmtTime(video.currentTime) + ' / ' + fmtTime(dur);
  });

  video.addEventListener('loadedmetadata', () => {
    document.getElementById('video-placeholder').style.display = 'none';
    document.getElementById('seek-bar').max = 100;
  });

  let seekTimer;
  video.addEventListener('seeking', () => {
    if (S.isSyncing) return;
    if (S.isHost) {
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => broadcastData({ type: 'seek', time: video.currentTime }), 250);
    } else if (S.allowViewerControl && S.hostDataConn?.open) {
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => S.hostDataConn.send({ type: 'seek', time: video.currentTime }), 300);
    }
  });
}

function togglePlayPause() {
  if (!S.isHost && !S.allowViewerControl) {
    showToast('🔒 Host mengunci kontrol video');
    return;
  }
  if (video.paused) video.play(); else video.pause();
}

function skip(sec) {
  if (!S.isHost && !S.allowViewerControl) return;
  video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + sec));
  if (S.isHost) broadcastData({ type: 'seek', time: video.currentTime });
  else if (S.hostDataConn?.open) S.hostDataConn.send({ type: 'seek', time: video.currentTime });
}

function onSeekInput(val) {
  if (!S.isHost && !S.allowViewerControl) return;
  const t = (val / 100) * (video.duration || 0);
  document.getElementById('time-display').textContent =
    fmtTime(t) + ' / ' + fmtTime(video.duration);
}

function onSeekChange(val) {
  if (!S.isHost && !S.allowViewerControl) {
    showToast('🔒 Kontrol dikunci oleh host');
    return;
  }
  const t = (val / 100) * (video.duration || 0);
  S.isSyncing = true;
  video.currentTime = t;
  S.isSyncing = false;
  if (S.isHost) broadcastData({ type: 'seek', time: t });
  else if (S.hostDataConn?.open) S.hostDataConn.send({ type: 'seek', time: t });
}

function setVolume(val) {
  video.volume = val;
  video.muted = val == 0;
}

function toggleFullscreen() {
  const w = document.getElementById('video-wrapper');
  if (!document.fullscreenElement) {
    (w.requestFullscreen || w.webkitRequestFullscreen || w.mozRequestFullScreen).call(w);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
}

function showControlsFor(ms = 3000) {
  const w = document.getElementById('video-wrapper');
  w.classList.add('ctl-on');
  clearTimeout(S.controlTimer);
  S.controlTimer = setTimeout(() => w.classList.remove('ctl-on'), ms);
}

function handleVideoWrapperClick(e) {
  if (e.target.classList.contains('vc-btn') ||
      e.target.classList.contains('seek-bar') ||
      e.target.classList.contains('vol-slider')) return;
  showControlsFor(3000);
}

let touchStartTime;
function handleTouchStart() { touchStartTime = Date.now(); }
function handleTouchEnd() {
  if (Date.now() - touchStartTime < 250) showControlsFor(3000);
}

// ── CHAT ─────────────────────────────────────

function sendChat() {
  const inp = document.getElementById('chat-input');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  addChatMsg({ name: S.myName, text, mine: true, isHost: S.isHost });
  if (S.isHost) {
    broadcastData({ type: 'chat', name: S.myName, text, isHost: true });
  } else if (S.hostDataConn?.open) {
    S.hostDataConn.send({ type: 'chat', name: S.myName, text });
  }
}

function addChatMsg({ name, text, mine, isHost }) {
  const msgs = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = 'chat-msg' + (mine ? ' mine' : '');
  div.innerHTML = `
    <div class="chat-name ${isHost ? 'host-name' : ''}">${esc(name)}${isHost ? ' 👑' : ''}</div>
    <div class="chat-text">${esc(text)}</div>
  `;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function addSysMsg(text) {
  const msgs = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = 'chat-msg sys';
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toggleChat() {
  const chat = document.getElementById('chat-side');
  chat.style.display = chat.style.display === 'none' ? '' : 'none';
}

// ── CHANGE VIDEO MODAL (HOST) ────────────────

function openChangeVideoModal() {
  document.getElementById('modal-change-video').classList.remove('hidden');
  document.getElementById('modal-video-url').value = '';
  document.getElementById('modal-file-name').textContent = '';
  S.pendingModalFile = null;
}

function closeModal() {
  document.getElementById('modal-change-video').classList.add('hidden');
}

function switchModalTab(tab) {
  S.modalTab = tab;
  document.querySelectorAll('#modal-change-video .source-tab').forEach((t, i) => {
    t.classList.toggle('active', (i === 0 && tab === 'url') || (i === 1 && tab === 'file'));
  });
  document.getElementById('modal-panel-url').classList.toggle('active', tab === 'url');
  document.getElementById('modal-panel-file').classList.toggle('active', tab === 'file');
}

async function applyVideoChange() {
  closeModal();
  showToast('⏳ Memuat video baru...');

  if (S.modalTab === 'url') {
    const url = document.getElementById('modal-video-url').value.trim();
    if (!url) { showToast('⚠️ Masukkan URL video'); return; }
    await hostLoadUrl(url);
    broadcastData({ type: 'video-change', videoKind: 'url', videoUrl: url });
  } else if (S.pendingModalFile) {
    await hostLoadFile(S.pendingModalFile);
    S.pendingModalFile = null;
    // Send new file to all connected viewers
    broadcastData({ type: 'video-change', videoKind: 'file' });
    for (const conn of S.connections) {
      if (conn.open) sendFileTo(conn);
    }
  } else {
    showToast('⚠️ Pilih file terlebih dahulu');
    return;
  }

  showToast('✅ Video berhasil diganti');
}
