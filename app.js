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
  // host video source
  videoKind: null,   // 'url' | 'file'
  videoUrl: null,
  // mp4box fragmented segments: { trackId: { mime, initSeg, segments[] } }
  streamTrackInfo: null,
  // fallback blob (non-mp4 or mp4box failure)
  fileBuffer: null,
  fileMime: '',
  // viewer MSE state
  mediaSource: null,
  trackSBs: {},    // trackId -> SourceBuffer
  trackQueues: {}, // trackId -> ArrayBuffer[]
  totalTracks: 0,
  tracksReady: 0,
};

const video = document.getElementById('video-player');

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
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
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

// ── HOST: VIDEO LOADING ──────────────────────

async function hostLoadFile(file) {
  showConnecting('Membaca file...');
  S.videoKind = 'file';
  S.fileMime = file.type || 'video/mp4';

  const buffer = await file.arrayBuffer();

  const isMP4 = S.fileMime.includes('mp4') || file.name.match(/\.(mp4|m4v)$/i);
  const hasMp4Box = typeof MP4Box !== 'undefined';

  if (isMP4 && hasMp4Box) {
    showConnecting('Memproses video untuk streaming...');
    const ok = await fragmentWithMp4box(buffer);
    if (!ok) {
      // mp4box failed, fall back to blob transfer
      S.videoKind = 'file-blob';
      S.fileBuffer = buffer;
    }
  } else {
    S.videoKind = 'file-blob';
    S.fileBuffer = buffer;
  }

  // Load for host playback
  const blob = new Blob([buffer], { type: S.fileMime });
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

// Fragment MP4 using mp4box.js → stores track info in S.streamTrackInfo
function fragmentWithMp4box(buffer) {
  return new Promise((resolve) => {
    const mp4boxFile = MP4Box.createFile();
    const trackInfo = {};
    let totalTracks = 0;
    let doneTracks = 0;
    let started = false;

    mp4boxFile.onReady = (info) => {
      const allTracks = [...(info.videoTracks || []), ...(info.audioTracks || [])];
      totalTracks = allTracks.length;

      if (totalTracks === 0) { resolve(false); return; }

      allTracks.forEach(track => {
        const isVideo = (info.videoTracks || []).some(t => t.id === track.id);
        const mime = `${isVideo ? 'video' : 'audio'}/mp4; codecs="${track.codec}"`;
        trackInfo[track.id] = { mime, initSeg: null, segments: [] };
        mp4boxFile.setSegmentOptions(track.id, null, { nbSamples: 100 });
      });

      const initSegs = mp4boxFile.initializeSegmentation();
      initSegs.forEach(seg => {
        if (trackInfo[seg.id]) trackInfo[seg.id].initSeg = seg.buffer.slice(0);
      });

      S.streamTrackInfo = trackInfo;
      started = true;
      mp4boxFile.start();
    };

    mp4boxFile.onSegment = (id, user, segBuffer, sampleNum, isLast) => {
      if (trackInfo[id]) {
        trackInfo[id].segments.push(segBuffer.slice(0));
      }
      if (isLast) {
        doneTracks++;
        if (doneTracks >= totalTracks) resolve(true);
      }
    };

    mp4boxFile.onError = () => resolve(false);

    // Fallback: resolve after 60s
    setTimeout(() => { if (!started || doneTracks < totalTracks) resolve(!!started); }, 60000);

    const ab = buffer.slice(0);
    ab.fileStart = 0;
    mp4boxFile.appendBuffer(ab);
    mp4boxFile.flush();
  });
}

// ── HOST: VIEWER MANAGEMENT ──────────────────

function handleNewViewer(conn) {
  S.connections.push(conn);

  conn.on('open', () => {
    conn.send({
      type: 'init',
      allowViewerControl: S.allowViewerControl,
      roomCode: S.roomCode,
      currentTime: video.currentTime,
      paused: video.paused,
      videoKind: S.videoKind,
      videoUrl: S.videoKind === 'url' ? S.videoUrl : null,
      fileMime: S.fileMime,
    });

    if (S.videoKind === 'file') {
      streamFileTo(conn);
    } else if (S.videoKind === 'file-blob') {
      sendBlobTo(conn);
    }

    const name = conn.metadata?.name || 'Penonton';
    const msg = `${name} bergabung 👋`;
    broadcastData({ type: 'sys', msg }, conn);
    addSysMsg(msg);
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

// Stream fragmented MP4 segments to viewer
async function streamFileTo(conn) {
  const trackInfo = S.streamTrackInfo;
  if (!trackInfo) return;

  // Tell viewer which tracks exist and their MIME types
  const trackMimes = {};
  for (const [id, info] of Object.entries(trackInfo)) {
    trackMimes[id] = info.mime;
  }
  conn.send({ type: 'stream-start', trackMimes });

  // Send init segments for each track
  for (const [id, info] of Object.entries(trackInfo)) {
    if (info.initSeg) {
      conn.send({ type: 'stream-init', trackId: Number(id), data: info.initSeg });
    }
  }

  // Interleave segments by index so viewer buffers audio+video together
  const trackIds = Object.keys(trackInfo);
  const maxSegs = Math.max(...trackIds.map(id => trackInfo[id].segments.length));

  for (let i = 0; i < maxSegs; i++) {
    if (!conn.open) break;
    for (const id of trackIds) {
      const seg = trackInfo[id].segments[i];
      if (seg) {
        const isLast = i === trackInfo[id].segments.length - 1;
        conn.send({ type: 'stream-seg', trackId: Number(id), index: i, total: trackInfo[id].segments.length, data: seg });
      }
    }
    // Yield every 10 rounds to avoid flooding the data channel
    if (i % 10 === 9) await new Promise(r => setTimeout(r, 16));
  }

  conn.send({ type: 'stream-done' });
}

// Fallback: send raw file as blob chunks (for non-MP4 or when mp4box fails)
async function sendBlobTo(conn) {
  const CHUNK = 65536;
  const buf = S.fileBuffer;
  if (!buf) return;
  const total = Math.ceil(buf.byteLength / CHUNK);
  conn.send({ type: 'blob-start', total, mime: S.fileMime });
  for (let i = 0; i < total; i++) {
    if (!conn.open) break;
    conn.send({ type: 'blob-chunk', index: i, data: buf.slice(i * CHUNK, (i + 1) * CHUNK) });
    if (i % 20 === 19) await new Promise(r => setTimeout(r, 15));
  }
  conn.send({ type: 'blob-end' });
}

function handleViewerData(conn, data) {
  switch (data.type) {
    case 'request-sync':
      conn.send({ type: 'sync', currentTime: video.currentTime, paused: video.paused });
      break;
    case 'chat':
      broadcastData({ type: 'chat', name: data.name, text: data.text }, conn);
      addChatMsg({ name: data.name, text: data.text, mine: false, isHost: false });
      break;
    case 'play':
      if (S.allowViewerControl) {
        S.isSyncing = true;
        video.currentTime = data.time;
        broadcastData({ type: 'play', time: data.time }, conn);
        video.play().catch(() => {});
        video.addEventListener('play', () => { S.isSyncing = false; }, { once: true });
      }
      break;
    case 'pause':
      if (S.allowViewerControl) {
        S.isSyncing = true;
        video.currentTime = data.time;
        video.pause();
        broadcastData({ type: 'pause', time: data.time }, conn);
        video.addEventListener('pause', () => { S.isSyncing = false; }, { once: true });
      }
      break;
    case 'seek':
      if (S.allowViewerControl) {
        S.isSyncing = true;
        video.currentTime = data.time;
        broadcastData({ type: 'seek', time: data.time }, conn);
        video.addEventListener('seeked', () => { S.isSyncing = false; }, { once: true });
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
    S.hostDataConn.on('open', () => { /* waiting for 'init' */ });
    S.hostDataConn.on('data', handleHostData);
    S.hostDataConn.on('close', () => showToast('❌ Host memutus koneksi'));
    S.hostDataConn.on('error', (e) => {
      hideConnecting();
      showToast('Gagal terhubung: ' + (e.message || e));
    });

    setTimeout(() => {
      if (!document.getElementById('screen-watch').classList.contains('active')) {
        hideConnecting();
        showToast('⏱ Timeout. Periksa kode room.');
        showScreen('join');
      }
    }, 20000);
  });

  S.peer.on('error', (err) => {
    hideConnecting();
    showToast(err.type === 'peer-unavailable'
      ? '❌ Room tidak ditemukan: ' + code
      : '❌ ' + err.message
    );
    showScreen('join');
  });
}

// ── VIEWER: HANDLE HOST DATA ─────────────────

// Viewer blob receive state
let rxChunks = [], rxTotal = 0, rxReceived = 0, rxMime = '';

function handleHostData(data) {
  switch (data.type) {

    case 'init':
      S.allowViewerControl = data.allowViewerControl;
      S.roomCode = data.roomCode;
      document.getElementById('topbar-code').textContent = data.roomCode || '------';
      if (data.videoKind === 'url') {
        viewerLoadUrl(data.videoUrl, data.currentTime, data.paused);
      } else {
        // Go to watch screen now, show buffer progress overlay on the video
        hideConnecting();
        showScreen('watch');
        setupWatchUI(false);
        updateControlsAccess();
        showBufferingOverlay('Menunggu video dari host...');
      }
      break;

    // ── MSE STREAMING PATH ──

    case 'stream-start':
      viewerSetupMSE(data.trackMimes);
      break;

    case 'stream-init':
      appendToTrack(data.trackId, data.data);
      break;

    case 'stream-seg': {
      appendToTrack(data.trackId, data.data);
      const pct = data.total ? Math.round((data.index / data.total) * 100) : 0;
      updateBufferingOverlay(`Buffering... ${pct}%`);
      // Auto-hide overlay and play once we have enough buffer
      const buf = video.buffered;
      if (buf.length > 0 && buf.end(0) >= 3) {
        hideBufferingOverlay();
      }
      break;
    }

    case 'stream-done': {
      const finalize = () => {
        if (S.mediaSource && S.mediaSource.readyState === 'open') {
          try { S.mediaSource.endOfStream(); } catch (e) {}
        }
      };
      const activeSBs = Object.values(S.trackSBs).filter(sb => sb.updating);
      if (activeSBs.length > 0) {
        activeSBs[0].addEventListener('updateend', finalize, { once: true });
      } else {
        finalize();
      }
      hideBufferingOverlay();
      break;
    }

    // ── BLOB FALLBACK PATH ──

    case 'blob-start':
      rxChunks = new Array(data.total);
      rxTotal = data.total;
      rxReceived = 0;
      rxMime = data.mime;
      updateBufferingOverlay('Mengunduh video... 0%');
      break;

    case 'blob-chunk':
      rxChunks[data.index] = data.data;
      rxReceived++;
      updateBufferingOverlay(`Mengunduh video... ${Math.round(rxReceived / rxTotal * 100)}%`);
      break;

    case 'blob-end': {
      const blob = new Blob(rxChunks, { type: rxMime });
      video.src = URL.createObjectURL(blob);
      video.load();
      video.addEventListener('canplay', () => {
        hideBufferingOverlay();
        document.getElementById('video-placeholder').style.display = 'none';
        S.hostDataConn.send({ type: 'request-sync' });
      }, { once: true });
      break;
    }

    // ── SYNC & PLAYBACK ──

    case 'sync':
      S.isSyncing = true;
      video.currentTime = data.currentTime;
      if (!data.paused) {
        video.play().catch(() => {});
        video.addEventListener('play', () => { S.isSyncing = false; }, { once: true });
      } else {
        video.addEventListener('seeked', () => { S.isSyncing = false; }, { once: true });
      }
      break;

    case 'play':
      document.getElementById('video-placeholder').style.display = 'none';
      S.isSyncing = true;
      video.currentTime = data.time;
      video.play().catch(() => {});
      video.addEventListener('play', () => { S.isSyncing = false; }, { once: true });
      break;

    case 'pause':
      S.isSyncing = true;
      video.currentTime = data.time;
      video.pause();
      video.addEventListener('pause', () => { S.isSyncing = false; }, { once: true });
      break;

    case 'seek':
      S.isSyncing = true;
      video.currentTime = data.time;
      video.addEventListener('seeked', () => { S.isSyncing = false; }, { once: true });
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
      addSysMsg('🎬 Host mengganti video...');
      // Reset MSE state
      S.mediaSource = null;
      S.trackSBs = {};
      S.trackQueues = {};
      if (data.videoKind === 'url') {
        viewerLoadUrl(data.videoUrl, 0, true);
      } else {
        showBufferingOverlay('Menerima video baru...');
      }
      break;
  }
}

// Viewer: set up MediaSource with separate SourceBuffers per track
function viewerSetupMSE(trackMimes) {
  // trackMimes: { "1": "video/mp4; codecs=...", "2": "audio/mp4; codecs=..." }
  const ms = new MediaSource();
  S.mediaSource = ms;
  S.trackSBs = {};
  S.trackQueues = {};
  S.totalTracks = Object.keys(trackMimes).length;
  S.tracksReady = 0;

  video.src = URL.createObjectURL(ms);

  ms.addEventListener('sourceopen', () => {
    for (const [trackId, mime] of Object.entries(trackMimes)) {
      if (!MediaSource.isTypeSupported(mime)) {
        console.warn('Unsupported MIME:', mime);
        continue;
      }
      try {
        const sb = ms.addSourceBuffer(mime);
        S.trackSBs[trackId] = sb;
        S.trackQueues[trackId] = [];
        sb.addEventListener('updateend', () => drainTrackQueue(trackId));
      } catch (e) {
        console.warn('addSourceBuffer failed:', mime, e);
      }
    }
    // Drain any data that arrived before sourceopen
    for (const trackId of Object.keys(S.trackSBs)) {
      drainTrackQueue(trackId);
    }
  }, { once: true });
}

function appendToTrack(trackId, buffer) {
  const id = String(trackId);
  if (!S.trackQueues[id]) S.trackQueues[id] = [];
  S.trackQueues[id].push(buffer);
  drainTrackQueue(id);
}

function drainTrackQueue(trackId) {
  const sb = S.trackSBs[trackId];
  const q = S.trackQueues[trackId];
  if (!sb || !q || q.length === 0 || sb.updating) return;
  if (!S.mediaSource || S.mediaSource.readyState !== 'open') return;
  try {
    sb.appendBuffer(q.shift());
  } catch (e) {
    console.warn('appendBuffer error:', e);
  }
}

function viewerLoadUrl(url, currentTime, paused) {
  video.src = url;
  video.load();
  hideConnecting();
  showScreen('watch');
  setupWatchUI(false);
  updateControlsAccess();

  const onReady = () => {
    document.getElementById('video-placeholder').style.display = 'none';
    S.isSyncing = true;
    video.currentTime = currentTime || 0;
    if (!paused) {
      video.play().catch(() => {});
      video.addEventListener('play', () => { S.isSyncing = false; }, { once: true });
    } else {
      video.addEventListener('seeked', () => { S.isSyncing = false; }, { once: true });
    }
  };

  if (video.readyState >= 3) {
    onReady();
  } else {
    video.addEventListener('canplay', onReady, { once: true });
  }
}

function viewerEnterWatch() {
  // Screen is already shown at init time; just sync playback position
  document.getElementById('video-placeholder').style.display = 'none';
  S.hostDataConn?.send({ type: 'request-sync' });
}

// Buffering overlay (shown over the video element while data is incoming)
function showBufferingOverlay(msg) {
  let el = document.getElementById('buffering-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'buffering-overlay';
    el.style.cssText = `
      position:absolute;inset:0;display:flex;flex-direction:column;
      align-items:center;justify-content:center;
      background:rgba(0,0,0,.65);z-index:20;border-radius:inherit;
      font-family:var(--font-body,sans-serif);color:#fff;gap:12px;
    `;
    el.innerHTML = `
      <div class="spinner" style="width:36px;height:36px;border:3px solid rgba(255,255,255,.2);border-top-color:var(--gold,#c89030);border-radius:50%;animation:spin .8s linear infinite"></div>
      <span id="buffering-txt" style="font-size:.9rem;opacity:.9"></span>
    `;
    document.getElementById('video-wrapper').appendChild(el);
  }
  document.getElementById('buffering-txt').textContent = msg;
  el.style.display = 'flex';
}

function updateBufferingOverlay(msg) {
  const el = document.getElementById('buffering-overlay');
  if (el) document.getElementById('buffering-txt').textContent = msg;
  else showBufferingOverlay(msg);
}

function hideBufferingOverlay() {
  const el = document.getElementById('buffering-overlay');
  if (el) el.style.display = 'none';
}

// ── WATCH UI ─────────────────────────────────

function setupWatchUI(isHost) {
  document.getElementById('topbar-code').textContent = S.roomCode || '------';
  document.getElementById('host-bar').style.display = isHost ? 'flex' : 'none';
  document.getElementById('toggle-ctrl-live').checked = S.allowViewerControl;
  if (isHost) updateViewerBadge(0);
  setupVideoEvents();
  updateControlsAccess();
  showControlsFor(3000);
  addSysMsg(isHost ? '🎬 Room dibuat. Bagikan kode ke teman!' : '👋 Bergabung ke room ' + S.roomCode);
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
  document.getElementById('time-display').textContent = fmtTime(t) + ' / ' + fmtTime(video.duration);
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

// ── CHANGE VIDEO MODAL ───────────────────────

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
    broadcastData({ type: 'video-change', videoKind: S.videoKind });
    for (const conn of S.connections) {
      if (!conn.open) continue;
      if (S.videoKind === 'file') streamFileTo(conn);
      else if (S.videoKind === 'file-blob') sendBlobTo(conn);
    }
  } else {
    showToast('⚠️ Pilih file terlebih dahulu');
    return;
  }

  showToast('✅ Video berhasil diganti');
}
