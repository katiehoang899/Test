'use strict';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const sessionId = params.get('id');

const frame = $('#frame');
const overlay = $('#overlay');
const overlayMsg = $('#overlayMsg');
const gazeDot = $('#gazeDot');

const CLICKS_PER_POINT = 5;
const MOVE_THROTTLE_MS = 50;
const SCROLL_THROTTLE_MS = 150;
const FLUSH_INTERVAL_MS = 2000;

let session = null;
let t0 = performance.now();
let queue = [];
let sentCount = 0;
let recording = false;      // tắt trong lúc hiệu chỉnh
let gazeEnabled = false;
let showDot = false;
let currentPage = null;     // URL gốc của trang đang hiển thị trong iframe
let frameWin = null;
let collectSamples = null;  // mảng tạm khi đo độ chính xác

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

function push(ev) {
  if (!recording && ev.type !== 'visibility' && ev.type !== 'leave') return;
  ev.t = now();
  if (currentPage && !ev.page) ev.page = currentPage;
  queue.push(ev);
}

async function flush() {
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  try {
    const res = await fetch(`/api/sessions/${sessionId}/events`, {
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
  if (navigator.sendBeacon(`/api/sessions/${sessionId}/events`, blob)) queue = [];
}

function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const t = performance.now();
    if (t - last >= ms) {
      last = t;
      fn(...args);
    }
  };
}

// ---------- mô tả phần tử được click ----------

function cssPath(el) {
  const parts = [];
  while (el && el.nodeType === 1 && parts.length < 5) {
    let part = el.tagName.toLowerCase();
    if (el.id) {
      parts.unshift(part + '#' + CSS.escape(el.id));
      break;
    }
    const parent = el.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    parts.unshift(part);
    el = parent;
  }
  return parts.join(' > ');
}

function describe(el) {
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 4).join(' ') : '';
  // Chỉ lấy nhãn hiển thị, không bao giờ lấy giá trị người dùng nhập vào ô input.
  const isField = /^(input|textarea|select)$/i.test(el.tagName);
  const text = isField
    ? (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '')
    : (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    cls: cls || undefined,
    text: text.slice(0, 120) || undefined,
    href: el.closest && el.closest('a[href]') ? el.closest('a[href]').href : undefined,
    selector: cssPath(el),
  };
}

// ---------- điều hướng trong iframe ----------

function navigate(url) {
  frame.src = '/proxy?url=' + encodeURIComponent(url);
}

function sameDocument(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    ua.hash = '';
    ub.hash = '';
    return ua.toString() === ub.toString();
  } catch {
    return false;
  }
}

function docSize(doc) {
  const de = doc.documentElement;
  const body = doc.body || de;
  return {
    dw: Math.max(de.scrollWidth, body.scrollWidth),
    dh: Math.max(de.scrollHeight, body.scrollHeight),
  };
}

function attachToFrame() {
  let doc;
  try {
    frameWin = frame.contentWindow;
    doc = frameWin.document;
    void doc.body; // ném lỗi nếu trang đã sang origin khác
  } catch {
    frameWin = null;
    currentPage = null;
    $('#pageUrl').textContent = '(trang đã rời khỏi công cụ — không theo dõi được)';
    toast('Trang đã chuyển sang địa chỉ ngoài proxy nên không thể ghi tương tác.');
    return;
  }

  const meta = doc.querySelector('meta[name="eyetrack-original-url"]');
  currentPage = meta ? meta.content : session.url;
  $('#pageUrl').textContent = currentPage;
  $('#pageUrl').title = currentPage;
  document.title = 'Đang theo dõi — ' + (doc.title || currentPage);

  const pageview = () => ({
    type: 'pageview',
    title: doc.title,
    vw: frameWin.innerWidth,
    vh: frameWin.innerHeight,
    sx: frameWin.scrollX,
    sy: frameWin.scrollY,
    ...docSize(doc),
  });
  push(pageview());
  // Trang thường cao thêm sau khi ảnh/JS tải xong → ghi lại kích thước.
  setTimeout(() => frameWin && push({ ...pageview(), type: 'resize' }), 1500);

  doc.addEventListener('mousemove', throttle((e) => {
    push({ type: 'move', x: e.pageX, y: e.pageY, vx: e.clientX, vy: e.clientY });
  }, MOVE_THROTTLE_MS), { capture: true, passive: true });

  // Đăng ký trên window (capture) trước bộ chặn link bên dưới để click luôn được ghi.
  frameWin.addEventListener('click', (e) => {
    const target = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
    if (target) {
      push({ type: 'click', x: e.pageX, y: e.pageY, vx: e.clientX, vy: e.clientY, el: describe(target) });
    }
    // Tiếp tục huấn luyện mô hình ánh mắt: người dùng thường nhìn vào chỗ họ click.
    if (gazeEnabled && window.webgazer) {
      const r = frame.getBoundingClientRect();
      try { webgazer.recordScreenPosition(e.clientX + r.left, e.clientY + r.top, 'click'); } catch { /* bỏ qua */ }
    }
  }, true);

  doc.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el && /^(input|textarea|select)$/i.test(el.tagName)) push({ type: 'focus', el: describe(el) });
  }, true);

  frameWin.addEventListener('scroll', throttle(() => {
    push({ type: 'scroll', sx: frameWin.scrollX, sy: frameWin.scrollY, vw: frameWin.innerWidth, vh: frameWin.innerHeight, ...docSize(doc) });
  }, SCROLL_THROTTLE_MS), { passive: true });

  frameWin.addEventListener('resize', throttle(() => push(pageview()), 300));

  // Giữ người dùng ở trong proxy để tiếp tục theo dõi khi họ bấm link.
  frameWin.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.href;
    if (!/^https?:/i.test(href)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (sameDocument(href, currentPage)) {
      const hash = decodeURIComponent(new URL(href).hash.slice(1));
      const target = hash && (doc.getElementById(hash) || doc.getElementsByName(hash)[0]);
      if (target) target.scrollIntoView({ behavior: 'smooth' });
      else if (!hash) frameWin.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    navigate(href);
  }, true);

  frameWin.addEventListener('submit', (e) => {
    const form = e.target;
    e.preventDefault();
    if ((form.method || 'get').toLowerCase() !== 'get') {
      toast('Form gửi bằng POST không được hỗ trợ trong chế độ theo dõi.');
      return;
    }
    const action = new URL(form.action || currentPage);
    action.search = new URLSearchParams(new FormData(form)).toString();
    navigate(action.toString());
  }, true);
}

frame.addEventListener('load', attachToFrame);

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

function setGazeStatus(text) {
  $('#gazeStatus').textContent = text;
}

function onGaze(data) {
  if (!data) {
    setGazeStatus('👁 không thấy khuôn mặt');
    gazeDot.style.display = 'none';
    return;
  }
  setGazeStatus('👁 đang theo dõi mắt');
  if (collectSamples) collectSamples.push({ x: data.x, y: data.y });

  if (showDot && recording) {
    gazeDot.style.display = 'block';
    gazeDot.style.left = data.x + 'px';
    gazeDot.style.top = data.y + 'px';
  } else {
    gazeDot.style.display = 'none';
  }

  if (!recording || !frameWin) return;
  const r = frame.getBoundingClientRect();
  const vx = data.x - r.left;
  const vy = data.y - r.top;
  if (vx < 0 || vy < 0 || vx > r.width || vy > r.height) return; // nhìn ra ngoài trang
  let sx = 0;
  let sy = 0;
  try {
    sx = frameWin.scrollX;
    sy = frameWin.scrollY;
  } catch {
    return;
  }
  push({ type: 'gaze', vx, vy, x: vx + sx, y: vy + sy });
}

async function startWebGazer() {
  setGazeStatus('Đang tải mô hình eye tracking…');
  await loadScript('/vendor/webgazer/webgazer.js');
  webgazer.params.faceMeshSolutionPath = '/vendor/webgazer/mediapipe/face_mesh';
  webgazer.saveDataAcrossSessions(false);
  webgazer.params.videoViewerWidth = 240;
  webgazer.params.videoViewerHeight = 180;
  await webgazer.setRegression('ridge').setGazeListener(onGaze).begin();
  webgazer.showPredictionPoints(false).applyKalmanFilter(true);
  const vc = document.getElementById('webgazerVideoContainer');
  if (vc) {
    Object.assign(vc.style, { left: '50%', top: '28%', transform: 'translate(-50%, -50%)', zIndex: 99995 });
  }
  gazeEnabled = true;
}

function showOverlay(html) {
  overlayMsg.innerHTML = html;
  overlay.hidden = false;
}

function waitClick(selector) {
  return new Promise((resolve) => overlay.querySelector(selector).addEventListener('click', resolve, { once: true }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function calibrate() {
  recording = false;
  webgazer.showVideoPreview(true).showFaceOverlay(true).showFaceFeedbackBox(true);
  webgazer.clearData();

  showOverlay(`
    <h2>Hiệu chỉnh eye tracking</h2>
    <p>Ngồi thẳng, giữ đầu cố định, đảm bảo khuôn mặt nằm trong khung xanh của camera.</p>
    <p>Sẽ có 9 chấm đỏ. <b>Nhìn chăm chú vào từng chấm và click vào nó ${CLICKS_PER_POINT} lần</b> cho đến khi chấm chuyển sang xanh.</p>
    <button class="primary" id="calStart">Bắt đầu hiệu chỉnh</button>`);
  await waitClick('#calStart');
  overlayMsg.innerHTML = '';

  const positions = [10, 50, 90].flatMap((y) => [10, 50, 90].map((x) => [x, y]));
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

  // Đo độ chính xác: người dùng nhìn vào điểm giữa màn hình trong 5 giây.
  webgazer.showVideoPreview(false);
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

  const cx = innerWidth / 2;
  const cy = innerHeight / 2;
  const meanErrorPx = samples.length
    ? samples.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / samples.length
    : null;
  const accuracy = meanErrorPx == null ? 0 : Math.max(0, 100 - (meanErrorPx / (innerHeight / 2)) * 100);

  fetch(`/api/sessions/${sessionId}`, {
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

  webgazer.showFaceOverlay(false).showFaceFeedbackBox(false);
  overlay.hidden = true;
  recording = true;
}

// ---------- khởi động ----------

async function init() {
  if (!/^[a-f0-9]{16}$/.test(sessionId || '')) {
    showOverlay('<h2>Thiếu mã phiên</h2><p><a href="/">Quay lại trang chủ</a></p>');
    return;
  }
  const res = await fetch('/api/sessions/' + sessionId);
  if (!res.ok) {
    showOverlay('<h2>Không tìm thấy phiên</h2><p><a href="/">Quay lại trang chủ</a></p>');
    return;
  }
  session = await res.json();
  $('#pageUrl').textContent = session.url;

  if (session.eyeTracking) {
    try {
      showOverlay('<h2>Đang khởi động camera…</h2><p>Hãy cho phép trình duyệt truy cập webcam.</p>');
      await startWebGazer();
      $('#toggleDot').hidden = false;
      $('#recalibrate').hidden = false;
      await calibrate();
    } catch (err) {
      console.error(err);
      gazeEnabled = false;
      setGazeStatus('👁 tắt');
      showOverlay(`<h2>Không bật được eye tracking</h2><p>${esc(err.message || err)}</p>
        <p>Vẫn có thể tiếp tục ghi chuột, click và cuộn trang.</p>
        <button class="primary" id="noGaze">Tiếp tục không có eye tracking</button>`);
      await waitClick('#noGaze');
      overlay.hidden = true;
    }
  }

  t0 = performance.now();
  recording = true;
  $('#recDot').classList.add('rec');
  navigate(session.url);
  setInterval(flush, FLUSH_INTERVAL_MS);
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
  await fetch(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ended: true }),
  }).catch(() => {});
  if (gazeEnabled) {
    try { webgazer.end(); } catch { /* bỏ qua */ }
  }
  location.href = '/report.html?id=' + sessionId;
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
