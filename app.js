const S = {
  peer: null,
  isHost: false,
  myName: 'Anonim',
  roomCode: null,
  allowViewerControl: false,
  connections: [],
  activeCalls: [],
  hostDataConn: null,
  hostMediaConn: null,
  videoStream: null,
  isSyncing: false,
  pendingFile: null,
  pendingModalFile: null,
  modalTab: 'url',
  controlTimer: null,
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

  // Drag & drop on setup file zone
  const setupZone = document.getElementById('setup-file-zone');
  ['dragover', 'dragenter'].forEach(ev =>
    setupZone.addEventListener(ev, e => {
      e.preventDefault();
      setupZone.classList.add('drag-over');
    })
  );
  ['dragleave', 'dragend', 'drop'].forEach(ev =>
    setupZone.addEventListener(ev, e => {
      e.preventDefault();
      setupZone.classList.remove('drag-over');
    })
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
  if (isNaN(s)) return '0:00';
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
  navigator.clipboard?.writeText(S.roomCode).then(() =>
    showToast('📋 Kode disalin: ' + S.roomCode)
  );
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
    hideConnecting();

    if (hasFile && S.pendingFile) {
      await hostLoadFile(S.pendingFile);
    } else if (urlVal) {
      await hostLoadUrl(urlVal);
    }

    showScreen('watch');
    setupWatchUI(true);
  });

  S.peer.on('error', (err) => {
    hideConnecting();
    if (err.type === 'unavailable-id') {
      initHostPeer(genCode(), urlVal, hasFile); // retry with new code
    } else {
      showToast('❌ Error: ' + err.message);
    }
  });

  S.peer.on('connection', (conn) => handleNewViewer(conn));

  S.peer.on('call', (call) => {
    const stream = S.videoStream || new MediaStream();
    call.answer(stream);
    S.activeCalls.push(call);
    call.on('close', () => { S.activeCalls = S.activeCalls.filter(c => c !== call); });
    call.on('error', () => { S.activeCalls = S.activeCalls.filter(c => c !== call); });
  });
}

async function hostLoadFile(file) {
  const url = URL.createObjectURL(file);
  video.src = url;
  video.srcObject = null;
  await waitForMetadata();
  captureHostStream();
  document.getElementById('video-placeholder').style.display = 'none';
}

async function hostLoadUrl(url) {
  video.src = url;
  video.srcObject = null;
  video.load();
  await waitForMetadata().catch(() => {});
  captureHostStream();
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
    setTimeout(res, 4000); // fallback timeout
  });
}

function captureHostStream() {
  if (!video.captureStream && !video.mozCaptureStream) return;
  try {
    S.videoStream = (video.captureStream || video.mozCaptureStream).call(video);
  } catch (e) {
    console.warn('captureStream failed:', e);
  }
}

async function replaceStreamTracks() {
  if (!S.videoStream) return;
  for (const call of S.activeCalls) {
    try {
      const senders = call.peerConnection?.getSenders() || [];
      for (const sender of senders) {
        if (!sender.track) continue;
        const newTrack = S.videoStream.getTracks().find(t => t.kind === sender.track.kind);
        if (newTrack) await sender.replaceTrack(newTrack);
      }
      if (senders.length === 0) {
        S.videoStream.getTracks().forEach(t => call.peerConnection?.addTrack(t, S.videoStream));
      }
    } catch (e) { console.warn('replaceTrack:', e); }
  }
}

function handleNewViewer(conn) {
  S.connections.push(conn);
  updateViewerBadge(S.connections.length);

  conn.on('open', () => {
    conn.send({
      type: 'init',
      allowViewerControl: S.allowViewerControl,
      roomCode: S.roomCode,
      currentTime: video.currentTime,
      paused: video.paused,
    });

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
    const sysMsg = `${name} keluar`;
    broadcastData({ type: 'sys', msg: sysMsg });
    addSysMsg(sysMsg);
  });

  conn.on('error', () => {
    S.connections = S.connections.filter(c => c !== conn);
    updateViewerBadge(S.connections.length);
  });
}

function handleViewerData(conn, data) {
  switch (data.type) {
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
      // Need a dummy stream to initiate the call
      const canvas = document.createElement('canvas');
      canvas.width = 2; canvas.height = 2;
      const emptyStream = canvas.captureStream ? canvas.captureStream() : new MediaStream();

      S.hostMediaConn = S.peer.call(code, emptyStream);

      S.hostMediaConn.on('stream', (stream) => {
        video.srcObject = stream;
        video.play().catch(() => {
          document.getElementById('placeholder-txt').textContent = 'Tap untuk mulai putar ▶';
          document.getElementById('video-placeholder').style.display = 'flex';
          document.getElementById('video-placeholder').onclick = () => {
            video.play();
            document.getElementById('video-placeholder').style.display = 'none';
            document.getElementById('video-placeholder').onclick = null;
          };
        });
        document.getElementById('video-placeholder').style.display = 'none';
        hideConnecting();
        showScreen('watch');
        setupWatchUI(false);
      });

      S.hostMediaConn.on('error', (e) => showToast('Media error: ' + e));
    });

    S.hostDataConn.on('data', handleHostData);
    S.hostDataConn.on('close', () => showToast('❌ Host memutus koneksi'));
    S.hostDataConn.on('error', (e) => {
      hideConnecting();
      showToast('Gagal terhubung: ' + (e.message || e));
    });

    setTimeout(() => {
      if (!video.srcObject) {
        hideConnecting();
        showToast('⏱ Timeout. Periksa kode room.');
        showScreen('join');
      }
    }, 15000);
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

function handleHostData(data) {
  switch (data.type) {
    case 'init':
      S.allowViewerControl = data.allowViewerControl;
      S.roomCode = data.roomCode;
      document.getElementById('topbar-code').textContent = data.roomCode || '------';
      updateControlsAccess();
      if (Math.abs(video.currentTime - data.currentTime) > 2) {
        S.isSyncing = true;
        video.currentTime = data.currentTime;
        S.isSyncing = false;
      }
      break;
    case 'play':
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
    case 'video-reload':
      addSysMsg('🎬 Host mengganti video...');
      document.getElementById('video-placeholder').style.display = 'none';
      break;
  }
}

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

  video.addEventListener('timeupdate', () => {
    const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
    const sb = document.getElementById('seek-bar');
    sb.value = pct;
    sb.style.background = `linear-gradient(to right, var(--gold) ${pct}%, rgba(255,255,255,.2) ${pct}%)`;
    document.getElementById('time-display').textContent =
      fmtTime(video.currentTime) + ' / ' + fmtTime(video.duration);
  });

  video.addEventListener('loadedmetadata', () => {
    document.getElementById('video-placeholder').style.display = 'none';
    document.getElementById('seek-bar').max = 100;
  });

  let seekTimer;
  video.addEventListener('seeking', () => {
    if (!S.isSyncing && S.isHost) {
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        broadcastData({ type: 'seek', time: video.currentTime });
      }, 250);
    }
  });

  if (!S.isHost) {
    video.addEventListener('seeking', () => {
      if (!S.isSyncing && S.allowViewerControl && S.hostDataConn?.open) {
        clearTimeout(seekTimer);
        seekTimer = setTimeout(() => {
          S.hostDataConn.send({ type: 'seek', time: video.currentTime });
        }, 300);
      }
    });
  }
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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toggleChat() {
  const chat = document.getElementById('chat-side');
  chat.style.display = chat.style.display === 'none' ? '' : 'none';
}

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
  } else if (S.pendingModalFile) {
    await hostLoadFile(S.pendingModalFile);
    S.pendingModalFile = null;
  } else {
    showToast('⚠️ Pilih file terlebih dahulu');
    return;
  }

  broadcastData({ type: 'video-reload' });

  setTimeout(async () => {
    captureHostStream();
    await replaceStreamTracks();
    showToast('✅ Video berhasil diganti');
  }, 800);
}
