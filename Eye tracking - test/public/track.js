'use strict';

// Màn hình theo dõi gồm 2 khung song song:
//  - trái: webcam (WebGazer) + trạng thái, bản đồ ánh mắt, thống kê
//  - phải: trình duyệt có thanh địa chỉ
//      · app desktop (Electron): <webview> mở thẳng website thật, bộ ghi chạy trong preload
//      · bản web: iframe đi qua reverse proxy của server (cùng origin để đọc được sự kiện)

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const sessionId = params.get('id');

const browserView = $('#browserView');
const overlay = $('#overlay');
const overlayMsg = $('#overlayMsg');
const gazeDot = $('#gazeDot');
const gazeMap = $('#gazeMap');

const CLICKS_PER_POINT = 5;
const FLUSH_INTERVAL_MS = 2000;
const GAZE_TRAIL = 40;

let session = null;
let t0 = performance.now();
let queue = [];
let sentCount = 0;
let recording = false;      // tắt trong lúc hiệu chỉnh
let gazeEnabled = false;
let showDot = false;
let currentPage = null;
let lastScroll = { sx: 0, sy: 0 };
let collectSamples = null;  // mảng tạm khi đo độ chính xác
let browser = null;         // adapter khung trình duyệt
const gazeTrail = [];
const stats = { clicks: 0, pages: new Set(), gazeThisSecond: 0 };

const now = () => Math.round(performance.now() - t0);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

const isDesktop = !!(window.etDesktop && window.etDesktop.webview);

function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  // App desktop mở được file HTML trên máy: chấp nhận cả đường dẫn /Users/…/trang.html.
  if (isDesktop && s.startsWith('/')) s = 'file://' + encodeURI(s);
  if (isDesktop && /^file:/i.test(s)) {
    try {
      return new URL(s).href;
    } catch {
      return null;
    }
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    // Không gõ giao thức: giữ giao thức của trang hiện tại nếu cùng tên miền, ngược lại dùng https.
    let proto = 'https:';
    try {
      const cur = new URL(currentPage);
      if (s.split(/[/?#]/)[0].toLowerCase() === cur.host.toLowerCase()) proto = cur.protocol;
    } catch { /* chưa có trang */ }
    s = proto + '//' + s;
  }
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

// ---------- hàng đợi sự kiện ----------

function push(ev) {
  if (!recording && ev.type !== 'visibility' && ev.type !== 'leave') return;
  ev.t = now();
  if (!ev.page && currentPage) ev.page = currentPage;
  queue.push(ev);
}

/** Sự kiện từ bộ ghi bên trong trang (iframe hoặc webview). */
function onPageEvent(ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return;
  if (ev.type === 'pageview' && ev.page) {
    currentPage = ev.page;
    stats.pages.add(ev.page);
    setAddress(ev.page);
  }
  if ('sy' in ev) lastScroll = { sx: ev.sx || 0, sy: ev.sy || 0 };
  if (ev.type === 'click') {
    stats.clicks++;
    // Tiếp tục huấn luyện mô hình ánh mắt: người dùng thường nhìn vào chỗ họ click.
    if (gazeEnabled && recording && window.webgazer && typeof ev.vx === 'number') {
      const r = browserView.getBoundingClientRect();
      try { webgazer.recordScreenPosition(ev.vx + r.left, ev.vy + r.top, 'click'); } catch { /* bỏ qua */ }
    }
  }
  push(ev);
}

async function flush() {
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  try {
    const res = await fetch(`/__et/api/sessions/${sessionId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    sentCount += batch.length;
    $('#eventCount').textContent = sentCount;
  } catch {
    queue = batch.concat(queue); // gửi lại ở lần sau
  }
}

function flushBeacon() {
  if (!queue.length) return;
  const blob = new Blob([JSON.stringify({ events: queue })], { type: 'application/json' });
  if (navigator.sendBeacon(`/__et/api/sessions/${sessionId}/events`, blob)) queue = [];
}

// ---------- khung trình duyệt ----------

function setAddress(url) {
  const input = $('#address');
  if (document.activeElement !== input) input.value = url;
  document.title = t('track.title', { url });
}

/** App desktop: <webview> là trình duyệt Chromium thật, mở thẳng website (không qua proxy). */
function createWebviewBrowser() {
  const wv = document.createElement('webview');
  wv.className = 'browser-frame';
  // Preload ghi tương tác và partition riêng được main process gán trong 'will-attach-webview'.
  wv.setAttribute('partition', 'persist:browse');
  // Cho phép yêu cầu mở cửa sổ mới tới được main process, nơi nó được mở ngay trong khung này.
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('src', 'about:blank');
  browserView.insertBefore(wv, overlay);

  let wvReady = false;
  wv.addEventListener('dom-ready', () => { wvReady = true; });
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'et') onPageEvent(e.args[0]);
  });
  const sync = () => {
    try {
      $('#navBack').disabled = !wv.canGoBack();
      $('#navForward').disabled = !wv.canGoForward();
    } catch { /* webview chưa sẵn sàng */ }
  };
  wv.addEventListener('did-navigate', (e) => { setAddress(e.url); sync(); });
  wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) setAddress(e.url); sync(); });
  wv.addEventListener('did-fail-load', (e) => {
    if (e.isMainFrame && e.errorCode !== -3) toast(t('track.page_failed', { err: e.errorDescription || e.errorCode }));
  });

  return {
    mode: session.kind === 'figma' ? t('track.mode_figma') : t('track.mode_live'),
    // trước 'dom-ready' đầu tiên webview chưa nhận loadURL → đợi rồi mới mở trang
    navigate: (url) => {
      const go = () => wv.loadURL(url).catch(() => {}); // lỗi tải trang đã báo qua 'did-fail-load'
      if (wvReady) go();
      else wv.addEventListener('dom-ready', go, { once: true });
    },
    back: () => wv.canGoBack() && wv.goBack(),
    forward: () => wv.canGoForward() && wv.goForward(),
    reload: () => wv.reload(),
  };
}

/** Bản web: iframe cùng origin, trang đích đi qua reverse proxy và giữ nguyên đường dẫn. */
function createIframeBrowser() {
  const frame = document.createElement('iframe');
  frame.className = 'browser-frame';
  frame.title = t('report.frame_title');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  browserView.insertBefore(frame, overlay);

  let targetOrigin = null;
  let recorder = null;
  const navigate = (url) => { frame.src = '/__et/go?url=' + encodeURIComponent(url); };

  frame.addEventListener('load', () => {
    if (recorder) recorder.dispose();
    recorder = null;
    let win;
    let doc;
    try {
      win = frame.contentWindow;
      doc = win.document;
      void doc.body; // ném lỗi nếu trang đã sang origin khác
    } catch {
      setAddress(t('track.left_tool'));
      toast(t('track.left_tool_toast'));
      return;
    }
    if (win.location.href === 'about:blank') return;

    const meta = doc.querySelector('meta[name="eyetrack-original-url"]');
    if (meta) targetOrigin = new URL(meta.content).origin;
    if (!targetOrigin) targetOrigin = new URL(session.url).origin;
    recorder = EtRecorder.installRecorder(win, onPageEvent, {
      getPageUrl: () => targetOrigin + win.location.pathname + win.location.search,
    });

    // Giữ người dùng ở trong công cụ khi bấm link tuyệt đối hoặc link mở tab mới.
    win.addEventListener('click', (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a || !/^https?:/i.test(a.href)) return;
      const u = new URL(a.href);
      const newTab = (a.target || '').toLowerCase() === '_blank';
      if (u.origin === location.origin) {
        if (!newTab) return; // link tương đối: để trang (hoặc router của SPA) tự xử lý
        e.preventDefault();
        e.stopImmediatePropagation();
        win.location.href = u.pathname + u.search + u.hash;
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      navigate(u.toString());
    }, true);

    win.addEventListener('submit', (e) => {
      const form = e.target;
      const action = new URL(form.action || win.location.href, win.location.href);
      if (action.origin === location.origin) return; // form của chính site: proxy chuyển tiếp bình thường
      e.preventDefault();
      if ((form.method || 'get').toLowerCase() !== 'get') {
        toast(t('track.form_blocked'));
        return;
      }
      action.search = new URLSearchParams(new FormData(form)).toString();
      navigate(action.toString());
    }, true);
  });

  const win = () => frame.contentWindow;
  return {
    mode: t('track.mode_proxy'),
    navigate,
    back: () => { try { win().history.back(); } catch { /* bỏ qua */ } },
    forward: () => { try { win().history.forward(); } catch { /* bỏ qua */ } },
    reload: () => { try { win().location.reload(); } catch { /* bỏ qua */ } },
  };
}

/**
 * Bản web + prototype Figma: nhúng bằng Figma Embed (iframe khác origin). Không đọc được chuột/click
 * bên trong, nhưng vẫn ghi ánh mắt (từ webcam ở trang cha) và màn hình đang hiển thị khi Figma
 * gửi sự kiện PRESENTED_NODE_CHANGED qua postMessage.
 */
function createFigmaEmbedBrowser() {
  const frame = document.createElement('iframe');
  frame.className = 'browser-frame';
  frame.title = t('report.frame_title');
  frame.allow = 'fullscreen';
  browserView.insertBefore(frame, overlay);
  $('#figmaNote').hidden = false;
  let protoUrl = null;

  const pageview = (page) => {
    if (page === currentPage) return; // Figma báo lại màn hình đang hiển thị → không tính thêm lượt xem
    const r = browserView.getBoundingClientRect();
    const vw = Math.round(r.width);
    const vh = Math.round(r.height);
    onPageEvent({ type: 'pageview', page, title: 'Figma', vw, vh, sx: 0, sy: 0, dw: vw, dh: vh });
  };
  frame.addEventListener('load', () => protoUrl && pageview(protoUrl));
  window.addEventListener('message', (e) => {
    if (e.origin !== 'https://www.figma.com' || !e.data || e.data.type !== 'PRESENTED_NODE_CHANGED') return;
    const nodeId = e.data.data && e.data.data.presentedNodeId;
    if (!nodeId || !protoUrl) return;
    const u = new URL(protoUrl);
    u.searchParams.set('node-id', String(nodeId).replace(/:/g, '-'));
    pageview(u.toString());
  });

  return {
    mode: t('track.mode_figma'),
    navigate: (url) => {
      protoUrl = url;
      frame.src = 'https://www.figma.com/embed?embed_host=heatmap&url=' + encodeURIComponent(url);
    },
    back: () => {},
    forward: () => {},
    reload: () => { if (protoUrl) frame.src = frame.src; },
  };
}

$('#browserBar').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = normalizeUrl($('#address').value);
  if (!url) return toast(t('track.bad_address'));
  $('#address').blur();
  browser.navigate(url);
});
$('#navBack').addEventListener('click', () => browser && browser.back());
$('#navForward').addEventListener('click', () => browser && browser.forward());
$('#navReload').addEventListener('click', () => browser && browser.reload());

// ---------- cột camera: ẩn/hiện (mặc định ẩn) ----------

let cameraPref = false;     // lựa chọn của người dùng, lưu trong Cài đặt
let cameraForced = false;   // hiện tạm trong lúc hiệu chỉnh để người dùng căn mặt

function applyCamera() {
  const show = cameraPref || cameraForced;
  $('#split').classList.toggle('camera-hidden', !show);
  const btn = $('#cameraToggle');
  btn.setAttribute('aria-pressed', String(show));
  const label = t(show ? 'track.camera_hide' : 'track.camera_show');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

$('#cameraToggle').addEventListener('click', () => {
  cameraPref = !(cameraPref || cameraForced);
  cameraForced = false;
  applyCamera();
  I18N.save({ showCamera: cameraPref }).catch(() => {});
});

// ---------- eye tracking (WebGazer) ----------

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(t('track.load_failed', { src })));
    document.head.appendChild(s);
  });
}

let faceVisible = null;
function setGazeStatus(text, ok) {
  const el = $('#gazeStatus');
  el.textContent = text;
  el.classList.toggle('ok', ok === true);
  el.classList.toggle('warn', ok === false);
}

function onGaze(data) {
  if (!data) {
    if (faceVisible !== false) setGazeStatus(t('track.no_face'), false);
    faceVisible = false;
    gazeDot.style.display = 'none';
    return;
  }
  if (faceVisible !== true) setGazeStatus(t('track.tracking'), true);
  faceVisible = true;
  if (collectSamples) collectSamples.push({ x: data.x, y: data.y });

  if (showDot && recording) {
    gazeDot.style.display = 'block';
    gazeDot.style.left = data.x + 'px';
    gazeDot.style.top = data.y + 'px';
  } else {
    gazeDot.style.display = 'none';
  }

  const r = browserView.getBoundingClientRect();
  const vx = data.x - r.left;
  const vy = data.y - r.top;
  const inside = vx >= 0 && vy >= 0 && vx <= r.width && vy <= r.height;
  gazeTrail.push({ x: vx / r.width, y: vy / r.height, inside });
  if (gazeTrail.length > GAZE_TRAIL) gazeTrail.shift();

  if (!recording || !inside || !currentPage) return;
  stats.gazeThisSecond++;
  push({ type: 'gaze', vx, vy, x: vx + lastScroll.sx, y: vy + lastScroll.sy });
}

function drawGazeMap() {
  const g = gazeMap.getContext('2d');
  const { width: w, height: h } = gazeMap;
  g.clearRect(0, 0, w, h);
  g.fillStyle = getComputedStyle(document.body).getPropertyValue('--bg') || '#f6f7f9';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(128,128,128,.35)';
  for (let i = 1; i < 3; i++) {
    g.beginPath(); g.moveTo((w * i) / 3, 0); g.lineTo((w * i) / 3, h); g.stroke();
    g.beginPath(); g.moveTo(0, (h * i) / 3); g.lineTo(w, (h * i) / 3); g.stroke();
  }
  gazeTrail.forEach((p, i) => {
    const a = (i + 1) / gazeTrail.length;
    const x = Math.max(0, Math.min(1, p.x)) * w;
    const y = Math.max(0, Math.min(1, p.y)) * h;
    g.beginPath();
    g.arc(x, y, i === gazeTrail.length - 1 ? 7 : 3, 0, Math.PI * 2);
    g.fillStyle = p.inside ? `rgba(230, 40, 60, ${a})` : `rgba(140, 140, 140, ${a * 0.6})`;
    g.fill();
  });
  requestAnimationFrame(drawGazeMap);
}

async function startWebGazer() {
  setGazeStatus(t('track.loading_model'));
  await loadScript('/__et/vendor/webgazer/webgazer.js');
  webgazer.params.faceMeshSolutionPath = '/__et/vendor/webgazer/mediapipe/face_mesh';
  webgazer.saveDataAcrossSessions(false);
  webgazer.params.videoViewerWidth = 320;
  webgazer.params.videoViewerHeight = 240;
  await webgazer.setRegression('ridge').setGazeListener(onGaze).begin();
  webgazer.showPredictionPoints(false).applyKalmanFilter(true);
  webgazer.showVideoPreview(true).showFaceOverlay(true).showFaceFeedbackBox(true);
  // Đưa khung video của WebGazer vào màn hình webcam bên trái.
  const vc = document.getElementById('webgazerVideoContainer');
  if (vc) {
    $('#camPlaceholder').remove();
    $('#camBox').appendChild(vc);
    vc.classList.add('cam-video');
  }
  gazeEnabled = true;
  requestAnimationFrame(drawGazeMap);
}

function showOverlay(html) {
  overlayMsg.innerHTML = html;
  overlay.hidden = false;
  browserView.classList.add('covered');
}

function hideOverlay() {
  overlay.hidden = true;
  browserView.classList.remove('covered');
}

function waitClick(selector) {
  return new Promise((resolve) => overlay.querySelector(selector).addEventListener('click', resolve, { once: true }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function calibrate() {
  recording = false;
  cameraForced = true;
  applyCamera();
  webgazer.clearData();

  showOverlay(`
    <h2>${esc(t('track.calib_title'))}</h2>
    <p>${esc(t('track.calib_p1'))}</p>
    <p>${t('track.calib_p2', { n: CLICKS_PER_POINT })}</p>
    <button class="primary" id="calStart">${esc(t('track.calib_start'))}</button>`);
  await waitClick('#calStart');
  overlayMsg.innerHTML = '';

  const positions = [8, 50, 92].flatMap((y) => [8, 50, 92].map((x) => [x, y]));
  await new Promise((resolve) => {
    let remaining = positions.length;
    for (const [x, y] of positions) {
      const p = document.createElement('div');
      p.className = 'calib-point';
      p.style.left = x + '%';
      p.style.top = y + '%';
      let clicks = 0;
      p.addEventListener('click', () => {
        clicks++;
        p.style.opacity = String(0.4 + (0.6 * clicks) / CLICKS_PER_POINT);
        if (clicks >= CLICKS_PER_POINT) {
          p.classList.add('done');
          if (--remaining === 0) resolve();
        }
      });
      overlay.appendChild(p);
    }
  });
  overlay.querySelectorAll('.calib-point').forEach((p) => p.remove());

  // Đo độ chính xác: người dùng nhìn vào điểm giữa khung trình duyệt trong 5 giây.
  webgazer.removeMouseEventListeners(); // không huấn luyện trong lúc đo
  showOverlay(`<p style="margin-top:80px">${t('track.calib_measure')}</p>`);
  const target = document.createElement('div');
  target.className = 'target-point';
  overlay.appendChild(target);
  await sleep(800);
  collectSamples = [];
  await sleep(5000);
  const samples = collectSamples;
  collectSamples = null;
  target.remove();
  webgazer.addMouseEventListeners();

  const r = overlay.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const meanErrorPx = samples.length
    ? samples.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / samples.length
    : null;
  const accuracy = meanErrorPx == null ? 0 : Math.max(0, 100 - (meanErrorPx / (r.height / 2)) * 100);
  $('#statAccuracy').textContent = Math.round(accuracy) + '%';

  fetch(`/__et/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calibration: { accuracy, meanErrorPx } }),
  }).catch(() => {});

  const good = accuracy >= 70;
  showOverlay(`
    <h2>${esc(t('track.accuracy_title', { n: Math.round(accuracy) }))}</h2>
    <p>${esc(meanErrorPx == null
      ? t('track.accuracy_none')
      : `${t('track.accuracy_err', { px: Math.round(meanErrorPx) })} ${good ? t('track.accuracy_good') : t('track.accuracy_low')}`)}</p>
    <button id="calRedo">${esc(t('track.calib_redo'))}</button>
    <button class="primary" id="calGo">${esc(t('track.calib_go'))}</button>`);
  const redo = await Promise.race([
    waitClick('#calRedo').then(() => true),
    waitClick('#calGo').then(() => false),
  ]);
  if (redo) return calibrate();

  hideOverlay();
  cameraForced = false;
  applyCamera();
  recording = true;
}

// ---------- khởi động ----------

function startClock() {
  setInterval(() => {
    const s = Math.floor(now() / 1000);
    $('#timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    $('#statRate').textContent = stats.gazeThisSecond;
    stats.gazeThisSecond = 0;
    $('#statClicks').textContent = stats.clicks;
    $('#statPages').textContent = stats.pages.size;
  }, 1000);
}

async function init() {
  await I18N.load();
  cameraPref = !!I18N.settings.showCamera;
  applyCamera();
  if (!/^[a-f0-9]{16}$/.test(sessionId || '')) {
    showOverlay(`<h2>${esc(t('track.missing_id'))}</h2><p><a href="/__et/">${esc(t('common.back_home'))}</a></p>`);
    return;
  }
  const res = await fetch('/__et/api/sessions/' + sessionId);
  if (!res.ok) {
    showOverlay(`<h2>${esc(t('track.not_found'))}</h2><p><a href="/__et/">${esc(t('common.back_home'))}</a></p>`);
    return;
  }
  session = await res.json();
  // người tham gia không xem báo cáo → nút chỉ là "Hoàn thành"
  if (session.guestId) {
    $('#finish').dataset.i18n = 'track.finish_guest';
    I18N.apply($('#finish').parentElement);
  }
  $('#statParticipant').textContent = session.participant || t('common.anonymous');
  setAddress(session.url);

  if (!isDesktop && /^file:/i.test(session.url)) {
    showOverlay(`<h2>${esc(t('track.need_desktop_title'))}</h2>
      <p>${t('track.need_desktop_p1', { url: esc(session.url) })}</p>
      <p>${t('track.need_desktop_p2')}</p>
      <p><a href="/__et/">${esc(t('common.back_home'))}</a></p>`);
    return;
  }

  if (!session.eyeTracking) document.body.classList.add('no-eye');
  if (isDesktop) browser = createWebviewBrowser();
  else if (session.kind === 'figma') browser = createFigmaEmbedBrowser();
  else browser = createIframeBrowser();
  $('#browserMode').textContent = browser.mode;

  if (session.eyeTracking) {
    try {
      showOverlay(`<h2>${esc(t('track.starting_camera'))}</h2><p>${esc(t('track.allow_camera'))}</p>`);
      await startWebGazer();
      $('#toggleDot').hidden = false;
      $('#recalibrate').hidden = false;
      await calibrate();
    } catch (err) {
      console.error(err);
      gazeEnabled = false;
      setGazeStatus(t('track.eye_off_status'), false);
      showOverlay(`<h2>${esc(t('track.eye_failed'))}</h2><p>${esc(err.message || err)}</p>
        <p>${esc(t('track.eye_failed_p'))}</p>
        <button class="primary" id="noGaze">${esc(t('track.continue_without'))}</button>`);
      await waitClick('#noGaze');
      hideOverlay();
    }
  } else {
    $('#camPlaceholder').textContent = t('track.eye_off_session');
    setGazeStatus(t('track.mouse_only'));
  }

  t0 = performance.now();
  recording = true;
  $('#recDot').classList.add('rec');
  browser.navigate(session.url);
  if (session.recordAudio) startAudioRecording();
  setInterval(flush, FLUSH_INTERVAL_MS);
  startClock();
}

$('#toggleDot').addEventListener('click', () => {
  showDot = !showDot;
  $('#toggleDot').textContent = showDot ? t('track.hide_dot') : t('track.show_dot');
});

$('#recalibrate').addEventListener('click', () => calibrate());

// ---------- ghi màn hình khung trình duyệt (Record | Pause | Stop) ----------

let screenRec = null;

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function renderRec() {
  const st = screenRec ? screenRec.state : 'idle';
  const active = st === 'recording' || st === 'paused';
  $('#recStart').hidden = active || st === 'stopping';
  $('#recPause').hidden = st !== 'recording';
  $('#recResume').hidden = st !== 'paused';
  $('#recStop').hidden = !active;
  $('#recTime').hidden = !active && st !== 'stopping';
  $('#recTime').classList.toggle('live', st === 'recording');
  $('#recTime').textContent = st === 'stopping' ? t('rec.saving') : `● ${fmtClock(screenRec ? screenRec.elapsed() : 0)}`;
}
setInterval(() => screenRec && screenRec.state !== 'stopped' && renderRec(), 500);

$('#recStart').addEventListener('click', async () => {
  $('#recStart').disabled = true;
  try {
    screenRec = await EtMedia.startScreen({
      sessionId,
      mediaId: 'screen-' + Date.now().toString(36),
      cropEl: browserView,
      now,
      onState: renderRec,
    });
  } catch (err) {
    console.error(err);
    screenRec = null;
    toast(t(isDesktop ? 'rec.failed_desktop' : 'rec.failed', { msg: err.message || err }), 7000);
  }
  $('#recStart').disabled = false;
  renderRec();
});
$('#recPause').addEventListener('click', () => screenRec && screenRec.pause());
$('#recResume').addEventListener('click', () => screenRec && screenRec.resume());
$('#recStop').addEventListener('click', async () => {
  if (!screenRec) return;
  const item = await screenRec.stop();
  if (item) toast(t('rec.saved', { time: fmtClock(item.durationMs || 0) }));
  renderRec();
});

// ---------- ghi âm micro (phiên bật webcam + chọn ghi âm) ----------

let audioRec = null;

function renderMic() {
  const st = audioRec ? audioRec.state : 'idle';
  $('#micChip').hidden = !audioRec;
  if (!audioRec) return;
  $('#micChip').classList.toggle('live', st === 'recording');
  $('#micTime').textContent = st === 'stopping' ? t('rec.saving') : fmtClock(audioRec.elapsed());
  const label = t(st === 'paused' ? 'mic.resume' : 'mic.pause');
  $('#micToggle').textContent = st === 'paused' ? '⏵' : '⏸';
  $('#micToggle').title = label;
  $('#micToggle').setAttribute('aria-label', label);
  $('#micToggle').hidden = st !== 'recording' && st !== 'paused';
}
setInterval(() => audioRec && audioRec.state !== 'stopped' && renderMic(), 500);

async function startAudioRecording() {
  try {
    if (window.etDesktop && window.etDesktop.askMicrophone) await window.etDesktop.askMicrophone();
    audioRec = await EtMedia.startAudio({ sessionId, mediaId: 'audio-' + Date.now().toString(36), now, onState: renderMic });
  } catch (err) {
    console.error(err);
    audioRec = null;
    toast(t('mic.failed', { msg: err.message || err }), 7000);
  }
  renderMic();
}

$('#micToggle').addEventListener('click', () => {
  if (!audioRec) return;
  if (audioRec.state === 'recording') audioRec.pause();
  else audioRec.resume();
  renderMic();
});

async function stopAllRecordings() {
  await Promise.all([
    screenRec && screenRec.state !== 'stopped' ? screenRec.stop() : null,
    audioRec && audioRec.state !== 'stopped' ? audioRec.stop() : null,
  ]);
}

$('#finish').addEventListener('click', async () => {
  $('#finish').disabled = true;
  await stopAllRecordings();
  push({ type: 'leave' });
  recording = false;
  await flush();
  await fetch(`/__et/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ended: true }),
  }).catch(() => {});
  if (gazeEnabled) {
    try { webgazer.end(); } catch { /* bỏ qua */ }
  }
  // người tham gia (guest) không xem được báo cáo → về trang của họ kèm lời cảm ơn
  location.href = session && session.guestId ? '/__et/guest.html?done=1' : '/__et/report.html?id=' + sessionId;
});

document.addEventListener('visibilitychange', () => {
  push({ type: 'visibility', hidden: document.hidden });
  if (document.hidden) flushBeacon();
});

window.addEventListener('pagehide', () => {
  push({ type: 'leave' });
  flushBeacon();
});

init();
