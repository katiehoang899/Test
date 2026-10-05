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
  document.title = 'Đang theo dõi — ' + url;
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
    if (e.isMainFrame && e.errorCode !== -3) toast(`Không tải được trang (${e.errorDescription || e.errorCode})`);
  });

  return {
    mode: 'Trình duyệt trực tiếp',
    navigate: (url) => wv.loadURL(url),
    back: () => wv.canGoBack() && wv.goBack(),
    forward: () => wv.canGoForward() && wv.goForward(),
    reload: () => wv.reload(),
  };
}

/** Bản web: iframe cùng origin, trang đích đi qua reverse proxy và giữ nguyên đường dẫn. */
function createIframeBrowser() {
  const frame = document.createElement('iframe');
  frame.className = 'browser-frame';
  frame.title = 'Trang đang test';
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
      setAddress('(trang đã rời khỏi công cụ — không theo dõi được)');
      toast('Trang đã chuyển sang địa chỉ ngoài proxy nên không thể ghi tương tác.');
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
        toast('Form gửi dữ liệu sang website khác không được hỗ trợ trong chế độ theo dõi.');
        return;
      }
      action.search = new URLSearchParams(new FormData(form)).toString();
      navigate(action.toString());
    }, true);
  });

  const win = () => frame.contentWindow;
  return {
    mode: 'Qua proxy',
    navigate,
    back: () => { try { win().history.back(); } catch { /* bỏ qua */ } },
    forward: () => { try { win().history.forward(); } catch { /* bỏ qua */ } },
    reload: () => { try { win().location.reload(); } catch { /* bỏ qua */ } },
  };
}

$('#browserBar').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = normalizeUrl($('#address').value);
  if (!url) return toast('Địa chỉ không hợp lệ.');
  $('#address').blur();
  browser.navigate(url);
});
$('#navBack').addEventListener('click', () => browser && browser.back());
$('#navForward').addEventListener('click', () => browser && browser.forward());
$('#navReload').addEventListener('click', () => browser && browser.reload());

// ---------- eye tracking (WebGazer) ----------

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Không tải được ' + src));
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
    if (faceVisible !== false) setGazeStatus('Không thấy khuôn mặt — nhìn thẳng vào camera', false);
    faceVisible = false;
    gazeDot.style.display = 'none';
    return;
  }
  if (faceVisible !== true) setGazeStatus('Đang theo dõi ánh mắt', true);
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
  setGazeStatus('Đang tải mô hình eye tracking…');
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
  webgazer.clearData();

  showOverlay(`
    <h2>Hiệu chỉnh eye tracking</h2>
    <p>Ngồi thẳng, giữ đầu cố định. Xem khung camera bên trái: khuôn mặt cần nằm trong khung xanh.</p>
    <p>Sẽ có 9 chấm đỏ trong khung trình duyệt. <b>Nhìn chăm chú vào từng chấm và click vào nó ${CLICKS_PER_POINT} lần</b> cho đến khi chấm chuyển sang xanh.</p>
    <button class="primary" id="calStart">Bắt đầu hiệu chỉnh</button>`);
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
  showOverlay('<p style="margin-top:80px">Giữ yên và <b>nhìn vào chấm vàng</b> trong 5 giây để đo độ chính xác…</p>');
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
    <h2>Độ chính xác: ${Math.round(accuracy)}%</h2>
    <p>${meanErrorPx == null
      ? 'Không nhận được dữ liệu ánh mắt — hãy kiểm tra camera và ánh sáng.'
      : `Sai số trung bình ~${Math.round(meanErrorPx)}px. ${good ? 'Tốt, có thể bắt đầu.' : 'Hơi thấp — nên hiệu chỉnh lại (ánh sáng đều, mặt nhìn thẳng camera).'}`}</p>
    <button id="calRedo">Hiệu chỉnh lại</button>
    <button class="primary" id="calGo">Bắt đầu duyệt trang</button>`);
  const redo = await Promise.race([
    waitClick('#calRedo').then(() => true),
    waitClick('#calGo').then(() => false),
  ]);
  if (redo) return calibrate();

  hideOverlay();
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
  if (!/^[a-f0-9]{16}$/.test(sessionId || '')) {
    showOverlay('<h2>Thiếu mã phiên</h2><p><a href="/__et/">Quay lại trang chủ</a></p>');
    return;
  }
  const res = await fetch('/__et/api/sessions/' + sessionId);
  if (!res.ok) {
    showOverlay('<h2>Không tìm thấy phiên</h2><p><a href="/__et/">Quay lại trang chủ</a></p>');
    return;
  }
  session = await res.json();
  $('#statParticipant').textContent = session.participant || 'ẩn danh';
  setAddress(session.url);

  if (!isDesktop && /^file:/i.test(session.url)) {
    showOverlay(`<h2>Cần app desktop để mở file trên máy</h2>
      <p>Trình duyệt không cho trang web đọc file <b>${esc(session.url)}</b>.</p>
      <p>Hãy mở bằng app Eye Tracking Studio (macOS), hoặc chạy web server cho thư mục đó
      (ví dụ <code>npx serve -l 5000 ~/Downloads</code>) rồi dùng link http://localhost:5000/… với ALLOW_PRIVATE=1.</p>
      <p><a href="/__et/">Quay lại trang chủ</a></p>`);
    return;
  }

  browser = isDesktop ? createWebviewBrowser() : createIframeBrowser();
  $('#browserMode').textContent = browser.mode;

  if (session.eyeTracking) {
    try {
      showOverlay('<h2>Đang khởi động camera…</h2><p>Hãy cho phép truy cập webcam.</p>');
      await startWebGazer();
      $('#toggleDot').hidden = false;
      $('#recalibrate').hidden = false;
      await calibrate();
    } catch (err) {
      console.error(err);
      gazeEnabled = false;
      setGazeStatus('Eye tracking tắt', false);
      showOverlay(`<h2>Không bật được eye tracking</h2><p>${esc(err.message || err)}</p>
        <p>Vẫn có thể tiếp tục ghi chuột, click và cuộn trang.</p>
        <button class="primary" id="noGaze">Tiếp tục không có eye tracking</button>`);
      await waitClick('#noGaze');
      hideOverlay();
    }
  } else {
    $('#camPlaceholder').textContent = 'Eye tracking đang tắt cho phiên này';
    setGazeStatus('Chỉ ghi chuột, click và cuộn trang');
  }

  t0 = performance.now();
  recording = true;
  $('#recDot').classList.add('rec');
  browser.navigate(session.url);
  setInterval(flush, FLUSH_INTERVAL_MS);
  startClock();
}

$('#toggleDot').addEventListener('click', () => {
  showDot = !showDot;
  $('#toggleDot').textContent = showDot ? 'Ẩn điểm nhìn' : 'Hiện điểm nhìn';
});

$('#recalibrate').addEventListener('click', () => calibrate());

$('#finish').addEventListener('click', async () => {
  $('#finish').disabled = true;
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
  location.href = '/__et/report.html?id=' + sessionId;
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
