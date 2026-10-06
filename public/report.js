'use strict';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const sessionId = params.get('id');

const frame = $('#pageFrame');
const stage = $('#stage');
const stageOuter = $('#stageOuter');
const canvas = $('#overlayCanvas');
const ctx = canvas.getContext('2d');
const minimap = $('#minimap');

const FIXATION_DISPERSION_PX = 100;  // webcam khá nhiễu nên ngưỡng rộng hơn eye tracker chuyên dụng
const FIXATION_MIN_MS = 150;
const FIXATION_MAX_GAP_MS = 300;

const state = {
  primary: null,      // phiên đang xem: { ...meta, events }
  sessions: [],       // các phiên được tính (1 hoặc nhiều khi gộp)
  page: null,
  view: null,         // { vw, vh, dh } kích thước khung nhìn đã ghi
  data: null,         // dữ liệu đã lọc cho trang hiện tại
  time: Infinity,     // mốc thời gian phát lại (ms, theo phiên chính)
  timeRange: [0, 0],
  playing: false,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Tránh Math.max(...arr) vì mảng mẫu ánh mắt có thể rất lớn (tràn stack).
function maxOf(list, f = (v) => v, init = 0) {
  let m = init;
  for (const v of list) {
    const x = f(v);
    if (x > m) m = x;
  }
  return m;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}${I18N.lang === 'vi' ? 'p' : 'm'} ${s % 60}s` : `${s}s`;
}

// ---------- tải dữ liệu ----------

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
  return res.json();
}

async function loadSessions() {
  if (!$('#merge').checked) {
    state.sessions = [state.primary];
    return;
  }
  const all = await getJson('/__et/api/sessions');
  const same = all.filter((s) => s.url === state.primary.url && s.id !== state.primary.id);
  const others = await Promise.all(same.map((s) => getJson('/__et/api/sessions/' + s.id).catch(() => null)));
  state.sessions = [state.primary, ...others.filter(Boolean)];
}

/** Tính các lượt xem trang: [{ page, start, end }] của một phiên. */
function visits(events) {
  const out = [];
  let cur = null;
  let last = 0;
  for (const e of events) {
    last = Math.max(last, e.t);
    if (e.type === 'pageview') {
      if (cur) cur.end = e.t;
      cur = { page: e.page, start: e.t, end: e.t, vw: e.vw, vh: e.vh };
      out.push(cur);
    } else if (cur && e.type !== 'visibility') {
      cur.end = e.t;
    }
  }
  return out;
}

/** I-DT: gom các mẫu ánh mắt gần nhau về không gian & liên tục về thời gian thành điểm dừng (fixation). */
function fixations(gaze) {
  const out = [];
  let i = 0;
  const disp = (a, b) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let k = a; k <= b; k++) {
      const p = gaze[k];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return maxX - minX + (maxY - minY);
  };
  while (i < gaze.length) {
    let j = i;
    while (j + 1 < gaze.length && gaze[j + 1].t - gaze[j].t <= FIXATION_MAX_GAP_MS && gaze[j].t - gaze[i].t < FIXATION_MIN_MS) j++;
    if (gaze[j].t - gaze[i].t < FIXATION_MIN_MS || disp(i, j) > FIXATION_DISPERSION_PX) {
      i++;
      continue;
    }
    while (j + 1 < gaze.length && gaze[j + 1].t - gaze[j].t <= FIXATION_MAX_GAP_MS && disp(i, j + 1) <= FIXATION_DISPERSION_PX) j++;
    let sx = 0, sy = 0;
    for (let k = i; k <= j; k++) {
      sx += gaze[k].x;
      sy += gaze[k].y;
    }
    const n = j - i + 1;
    out.push({ x: sx / n, y: sy / n, t: gaze[i].t, dur: gaze[j].t - gaze[i].t });
    i = j + 1;
  }
  return out;
}

function buildPageData() {
  const page = state.page;
  const perSession = state.sessions.map((s, idx) => {
    const ev = s.events.filter((e) => e.page === page);
    const gaze = ev.filter((e) => e.type === 'gaze');
    return {
      id: s.id,
      idx,
      session: s,
      events: ev,
      gaze,
      move: ev.filter((e) => e.type === 'move'),
      click: ev.filter((e) => e.type === 'click'),
      scroll: ev.filter((e) => e.type === 'scroll' || e.type === 'pageview' || e.type === 'resize'),
      fix: fixations(gaze),
      visits: visits(s.events).filter((v) => v.page === page),
    };
  });
  state.data = perSession;

  // Khung nhìn: lấy từ lượt xem đầu tiên của phiên chính (hoặc phiên đầu tiên có dữ liệu).
  const ref = perSession.find((p) => p.visits.length) || perSession[0];
  const pv = ref.events.find((e) => e.type === 'pageview') || {};
  const dh = Math.max(
    maxOf(perSession, (p) => maxOf(p.scroll, (e) => e.dh || 0)),
    maxOf(perSession, (p) => maxOf(p.gaze, (e) => e.y)),
    maxOf(perSession, (p) => maxOf(p.move, (e) => e.y))
  );
  state.view = { vw: pv.vw || 1280, vh: pv.vh || 800, dh: Math.max(dh, pv.vh || 800) };

  const main = perSession[0];
  // events đã theo thứ tự thời gian ghi
  state.timeRange = main.events.length ? [main.events[0].t, main.events[main.events.length - 1].t] : [0, 0];
  state.time = Infinity;
}

// ---------- heatmap ----------

let paletteCache = null;
function palette() {
  if (paletteCache) return paletteCache;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 1;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0, 'rgb(0,0,255)');
  grad.addColorStop(0.25, 'cyan');
  grad.addColorStop(0.5, 'lime');
  grad.addColorStop(0.75, 'yellow');
  grad.addColorStop(1, 'red');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 1);
  paletteCache = g.getImageData(0, 0, 256, 1).data;
  return paletteCache;
}

const HEAT_CELL = 4; // tính mật độ trên lưới thô rồi phóng to — nhanh và cộng dồn tuyến tính

function drawHeatmap(points, r, opacity, sx, sy) {
  const { width: w, height: h } = canvas;
  const gw = Math.ceil(w / HEAT_CELL);
  const gh = Math.ceil(h / HEAT_CELL);
  const grid = new Float32Array(gw * gh);
  const rc = r / HEAT_CELL;
  const ri = Math.ceil(rc);
  let drawn = 0;
  for (const p of points) {
    const cx = (p.x - sx) / HEAT_CELL;
    const cy = (p.y - sy) / HEAT_CELL;
    if (cx < -ri || cy < -ri || cx > gw + ri || cy > gh + ri) continue;
    drawn++;
    const x0 = Math.max(0, Math.floor(cx - ri));
    const x1 = Math.min(gw - 1, Math.ceil(cx + ri));
    const y0 = Math.max(0, Math.floor(cy - ri));
    const y1 = Math.min(gh - 1, Math.ceil(cy + ri));
    for (let gy = y0; gy <= y1; gy++) {
      const dy = gy - cy;
      for (let gx = x0; gx <= x1; gx++) {
        const dx = gx - cx;
        const d = Math.sqrt(dx * dx + dy * dy) / rc;
        if (d < 1) grid[gy * gw + gx] += (1 - d) * (1 - d);
      }
    }
  }
  if (!drawn) return;
  let max = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] > max) max = grid[i];
  const small = document.createElement('canvas');
  small.width = gw;
  small.height = gh;
  const sctx = small.getContext('2d');
  const img = sctx.createImageData(gw, gh);
  const d = img.data;
  const pal = palette();
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i] / max;
    if (v < 0.01) continue;
    const k = Math.round(v * 255) * 4;
    d[i * 4] = pal[k];
    d[i * 4 + 1] = pal[k + 1];
    d[i * 4 + 2] = pal[k + 2];
    d[i * 4 + 3] = Math.round(Math.min(1, v * 4) * (0.45 + 0.55 * v) * opacity * 255);
  }
  sctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(small, 0, 0, gw * HEAT_CELL, gh * HEAT_CELL);
}

function drawScanpath(perSession, sx, sy) {
  for (const s of perSession) {
    const fix = s.fix.filter((f) => f.t <= state.time || s.idx > 0);
    const hue = (210 + s.idx * 67) % 360;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `hsla(${hue}, 80%, 45%, .7)`;
    ctx.beginPath();
    fix.forEach((f, k) => (k ? ctx.lineTo(f.x - sx, f.y - sy) : ctx.moveTo(f.x - sx, f.y - sy)));
    ctx.stroke();
    fix.forEach((f, k) => {
      const x = f.x - sx;
      const y = f.y - sy;
      if (y < -60 || y > canvas.height + 60) return;
      const r = Math.min(40, 8 + Math.sqrt(f.dur) * 0.9);
      ctx.fillStyle = `hsla(${hue}, 85%, 55%, .45)`;
      ctx.strokeStyle = `hsla(${hue}, 80%, 35%, .9)`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(k + 1), x, y);
    });
  }
}

function drawClickMarks(points, sx, sy) {
  for (const p of points) {
    const x = p.x - sx;
    const y = p.y - sy;
    if (y < -10 || y > canvas.height + 10) continue;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 60, 60, .85)';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  }
}

function lastBefore(list, t) {
  let found = null;
  for (const e of list) {
    if (e.t > t) break;
    found = e;
  }
  return found;
}

function scrollPos() {
  return pageView.scroll();
}

let rafPending = false;
function redraw() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    render();
  });
}

function render() {
  if (!state.data) return;
  const { sx, sy } = scrollPos();
  const layer = $('#layer').value;
  const r = Number($('#radius').value);
  const opacity = Number($('#opacity').value) / 100;
  const merged = state.data.length > 1;
  const inTime = (e, s) => merged || s.idx > 0 || e.t <= state.time;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (layer === 'scanpath') {
    drawScanpath(state.data, sx, sy);
  } else {
    const pts = state.data.flatMap((s) => s[layer].filter((e) => inTime(e, s)));
    drawHeatmap(pts, r, opacity, sx, sy);
  }
  if ($('#showClicks').checked && layer !== 'click') {
    drawClickMarks(state.data.flatMap((s) => s.click.filter((e) => inTime(e, s))), sx, sy);
  }

  // Khi đang tua: vẽ vị trí mắt & chuột tại thời điểm đó.
  if (!merged && Number.isFinite(state.time)) {
    const main = state.data[0];
    const g = lastBefore(main.gaze, state.time);
    if (g && state.time - g.t < 500) {
      ctx.beginPath();
      ctx.arc(g.x - sx, g.y - sy, 14, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 0, 80, .5)';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.fill();
      ctx.stroke();
    }
    const m = lastBefore(main.move, state.time);
    if (m) {
      const x = m.x - sx;
      const y = m.y - sy;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + 18);
      ctx.lineTo(x + 5, y + 13);
      ctx.lineTo(x + 12, y + 13);
      ctx.closePath();
      ctx.fillStyle = '#111';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    }
  }
  renderMinimap(sy);
}

// ---------- minimap ----------

function renderMinimap(sy) {
  const { vh, dh } = state.view;
  const h = Math.round(stageOuter.getBoundingClientRect().height) || 400;
  minimap.height = h;
  minimap.width = 46;
  minimap.style.height = h + 'px';
  const m = minimap.getContext('2d');
  m.clearRect(0, 0, 46, h);
  const layer = $('#layer').value === 'scanpath' ? 'gaze' : $('#layer').value;
  const bins = new Array(Math.max(1, Math.round(h / 4))).fill(0);
  for (const s of state.data) {
    for (const e of s[layer]) {
      const b = Math.min(bins.length - 1, Math.floor((e.y / dh) * bins.length));
      if (b >= 0) bins[b]++;
    }
  }
  const max = Math.max(1, ...bins);
  const pal = palette();
  const bh = h / bins.length;
  bins.forEach((v, i) => {
    if (!v) return;
    const k = Math.round((v / max) * 255) * 4;
    m.fillStyle = `rgb(${pal[k]},${pal[k + 1]},${pal[k + 2]})`;
    m.fillRect(0, i * bh, (v / max) * 46, Math.ceil(bh));
  });
  // khung đang xem
  m.strokeStyle = '#2f6fed';
  m.lineWidth = 2;
  m.strokeRect(1, (sy / dh) * h, 44, Math.max(4, (vh / dh) * h));
  // độ sâu cuộn lớn nhất
  const maxReach = maxOf(state.data, (s) => maxOf(s.scroll, (e) => (e.sy || 0) + (e.vh || vh)));
  m.strokeStyle = '#d92d20';
  m.setLineDash([4, 3]);
  m.beginPath();
  m.moveTo(0, (maxReach / dh) * h);
  m.lineTo(46, (maxReach / dh) * h);
  m.stroke();
  m.setLineDash([]);
}

minimap.addEventListener('click', (e) => {
  const rect = minimap.getBoundingClientRect();
  const y = ((e.clientY - rect.top) / rect.height) * state.view.dh - state.view.vh / 2;
  pageView.scrollTo(0, Math.max(0, y));
});

// ---------- thống kê ----------

function renderStats() {
  const d = state.data;
  const { vh } = state.view;
  const sum = (f) => d.reduce((a, s) => a + f(s), 0);
  const time = sum((s) => s.visits.reduce((a, v) => a + (v.end - v.start), 0));
  const gazeN = sum((s) => s.gaze.length);
  const fixN = sum((s) => s.fix.length);
  const fixDur = sum((s) => s.fix.reduce((a, f) => a + f.dur, 0));
  const aboveFold = sum((s) => s.gaze.filter((g) => g.y <= vh).length);
  const maxDepth = maxOf(d, (s) => maxOf(s.scroll, (e) => (e.dh ? Math.min(100, (((e.sy || 0) + (e.vh || vh)) / e.dh) * 100) : 0)));
  const firstFix = d[0].fix[0];
  const calib = d[0].session.calibration;

  const rows = [
    ['stat.sessions', d.length],
    ['stat.time', fmtDuration(time)],
    ['stat.viewport', `${state.view.vw}×${state.view.vh}`],
    ['stat.gaze', gazeN, true],
    ['stat.fixations', fixN, true],
    ['stat.fix_avg', fixN ? Math.round(fixDur / fixN) + 'ms' : '—', true],
    ['stat.above_fold', gazeN ? Math.round((aboveFold / gazeN) * 100) + '%' : '—', true],
    ['stat.first_fix', firstFix && d[0].visits[0] ? (Math.max(0, firstFix.t - d[0].visits[0].start) / 1000).toFixed(1) + 's' : '—'],
    ['stat.clicks', sum((s) => s.click.length)],
    ['stat.depth', Math.round(maxDepth) + '%'],
    ['stat.accuracy', calib && calib.accuracy != null ? Math.round(calib.accuracy) + '%' : '—', true],
  ];
  $('#stats').innerHTML = rows
    .map(([k, v, eye]) => `<div class="stat${eye ? ' eye-only' : ''}"><span>${esc(t(k))}</span><b>${esc(v)}</b></div>`)
    .join('');

  const groups = new Map();
  for (const c of d.flatMap((s) => s.click)) {
    const el = c.el || {};
    const key = el.selector || el.tag || '?';
    const g = groups.get(key) || { key, text: el.text, tag: el.tag, n: 0 };
    g.n++;
    groups.set(key, g);
  }
  const top = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 10);
  $('#topClicks').innerHTML = top.length
    ? top.map((g) => `<li><b>${g.n}×</b> ${esc(g.text ? `"${g.text.slice(0, 60)}"` : '')} <span class="muted">${esc(g.key)}</span></li>`).join('')
    : `<li class="muted" style="list-style: none; margin-left: -18px">${esc(t('report.no_clicks'))}</li>`;
}

// ---------- khung trang & phát lại ----------

function layoutStage() {
  const { vw, vh } = state.view;
  canvas.width = vw;
  canvas.height = vh;
  stage.style.width = vw + 'px';
  stage.style.height = vh + 'px';
  const avail = stageOuter.clientWidth || vw;
  const s = Math.min(1, avail / vw);
  stage.style.transform = `scale(${s})`;
  stageOuter.style.height = vh * s + 'px';
}

// Nền trang của báo cáo:
//  - app desktop: <webview> mở thẳng trang (kể cả file:// trên máy); vị trí cuộn nhận qua bộ ghi trong preload
//  - bản web: iframe qua reverse proxy (cùng origin nên đọc/đặt vị trí cuộn trực tiếp)
const BLOCK_INTERACTION = `(() => {
  const stop = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  window.addEventListener('click', stop, true);
  window.addEventListener('submit', stop, true);
})();`;

function createWebviewView() {
  const wv = document.createElement('webview');
  wv.id = 'pageFrame';
  wv.setAttribute('partition', 'persist:browse');
  frame.replaceWith(wv);
  let pos = { sx: 0, sy: 0 };
  let ready = false;
  wv.addEventListener('ipc-message', (e) => {
    const ev = e.channel === 'et' && e.args[0];
    if (ev && typeof ev.sy === 'number') {
      pos = { sx: ev.sx || 0, sy: ev.sy };
      redraw();
    }
  });
  wv.addEventListener('did-start-loading', () => { ready = false; pos = { sx: 0, sy: 0 }; });
  wv.addEventListener('dom-ready', () => {
    ready = true;
    // Báo cáo chỉ để xem: chặn click/submit để trang không chuyển đi nơi khác.
    wv.executeJavaScript(BLOCK_INTERACTION).catch(() => {});
    syncReplayScroll();
    redraw();
  });
  return {
    get ready() { return ready; },
    load: (url) => wv.setAttribute('src', url),
    scroll: () => pos,
    scrollTo: (x, y) => {
      if (ready) wv.executeJavaScript(`window.scrollTo(${Number(x) || 0}, ${Number(y) || 0})`).catch(() => {});
    },
  };
}

function createIframeView() {
  let win = null;
  frame.addEventListener('load', () => {
    try {
      const w = frame.contentWindow;
      void w.document.body;
      win = w;
      win.eval(BLOCK_INTERACTION);
      win.addEventListener('scroll', redraw, { passive: true });
    } catch {
      win = null;
    }
    syncReplayScroll();
    redraw();
  });
  return {
    get ready() { return !!win; },
    load: (url) => {
      win = null;
      if (/^file:/i.test(url)) {
        // Trình duyệt không cho trang web mở file trên máy → chỉ vẽ heatmap trên nền trống.
        frame.srcdoc = `<p style="font:14px system-ui;color:#667085;padding:24px">${t('report.file_web')}</p>`;
        return;
      }
      if (/^https:\/\/(www\.)?figma\.com\//i.test(url)) {
        // Figma ở bản web: nhúng bằng Figma Embed (khác origin, không cuộn).
        frame.removeAttribute('srcdoc');
        frame.src = 'https://www.figma.com/embed?embed_host=heatmap&url=' + encodeURIComponent(url);
        return;
      }
      frame.removeAttribute('srcdoc');
      frame.src = '/__et/go?url=' + encodeURIComponent(url);
    },
    scroll: () => {
      try {
        return { sx: win.scrollX, sy: win.scrollY };
      } catch {
        return { sx: 0, sy: 0 };
      }
    },
    scrollTo: (x, y) => {
      try { win.scrollTo(x, y); } catch { /* iframe không truy cập được */ }
    },
  };
}

const pageView = window.etDesktop && window.etDesktop.webview ? createWebviewView() : createIframeView();

function loadFrame() {
  pageView.load(state.page);
}

function updateTimeline() {
  const merged = state.data.length > 1;
  $('.timeline').style.display = merged ? 'none' : '';
  const [a, b] = state.timeRange;
  const slider = $('#time');
  slider.min = a;
  slider.max = b;
  if (!Number.isFinite(state.time)) slider.value = b;
  const cur = Number.isFinite(state.time) ? state.time : b;
  $('#timeLabel').textContent = `${fmtDuration(cur - a)} / ${fmtDuration(b - a)}`;
}

function syncReplayScroll() {
  if (!Number.isFinite(state.time) || !pageView.ready || state.data.length > 1) return;
  const e = lastBefore(state.data[0].scroll, state.time);
  if (e) pageView.scrollTo(e.sx || 0, e.sy || 0);
}

function setTime(t) {
  const [, b] = state.timeRange;
  state.time = t >= b ? Infinity : t;
  updateTimeline();
  syncReplayScroll();
  redraw();
}

$('#time').addEventListener('input', (e) => {
  stopPlay();
  setTime(Number(e.target.value));
});

let playStart = 0;
let playFrom = 0;
function tick(now) {
  if (!state.playing) return;
  const t = playFrom + (now - playStart);
  setTime(Math.min(t, state.timeRange[1]));
  if (t >= state.timeRange[1]) stopPlay();
  else requestAnimationFrame(tick);
}

function stopPlay() {
  state.playing = false;
  $('#play').textContent = t('report.play');
}

$('#play').addEventListener('click', () => {
  if (state.playing) return stopPlay();
  state.playing = true;
  $('#play').textContent = t('report.pause');
  playFrom = Number.isFinite(state.time) ? state.time : state.timeRange[0];
  playStart = performance.now();
  requestAnimationFrame(tick);
});

// ---------- điều khiển ----------

function fillPageSelect() {
  const counts = new Map();
  for (const s of state.sessions) {
    for (const v of visits(s.events)) counts.set(v.page, (counts.get(v.page) || 0) + 1);
  }
  if (!counts.size) counts.set(state.primary.url, 0);
  const sel = $('#pageSelect');
  sel.innerHTML = [...counts].map(([p, n]) => `<option value="${esc(p)}">${esc(shortPage(p))} (${esc(t(n === 1 ? 'report.view_one' : 'report.views', { n }))})</option>`).join('');
  if (state.page && counts.has(state.page)) sel.value = state.page;
  state.page = sel.value;
}

function showPage() {
  stopPlay();
  buildPageData();
  layoutStage();
  updateTimeline();
  renderStats();
  renderCharts();
  loadFrame();
  redraw();
}

$('#pageSelect').addEventListener('change', (e) => {
  state.page = e.target.value;
  showPage();
});

$('#merge').addEventListener('change', async () => {
  await loadSessions();
  fillPageSelect();
  showPage();
});

function renderRangeLabels() {
  $('#radiusLabel').textContent = t('report.radius', { n: $('#radius').value });
  $('#opacityLabel').textContent = t('report.opacity', { n: $('#opacity').value });
}

for (const id of ['#layer', '#radius', '#opacity', '#showClicks']) {
  $(id).addEventListener('input', () => {
    renderRangeLabels();
    redraw();
  });
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!state.view) return;
  layoutStage();
  redraw();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderCharts, 150);
});

// Đổi ngôn ngữ ngay trên trang báo cáo.
document.querySelectorAll('.lang-switch button').forEach((b) => b.addEventListener('click', () => I18N.save({ language: b.dataset.lang })));
document.addEventListener('i18n:change', (e) => {
  document.querySelectorAll('.lang-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === e.detail.language)));
  document.title = t('report.title') + ' — Heatmap';
  renderRangeLabels();
  if (!state.primary) return;
  renderHeader();
  renderMedia();
  fillPageSelect();
  renderStats();
  renderCharts();
  $('#play').textContent = state.playing ? t('report.pause') : t('report.play');
});

// ---------- biểu đồ ----------

/** Tên ngắn của một trang để làm nhãn biểu đồ (URL đầy đủ nằm trong tooltip và bảng). */
function shortPage(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)figma\.com$/.test(u.hostname)) return 'Figma ' + (u.searchParams.get('node-id') || u.pathname.split('/')[3] || '');
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.split('/').pop() || u.pathname);
    const path = decodeURIComponent(u.pathname + u.search);
    return path === '/' ? u.host : path;
  } catch {
    return url;
  }
}

/** Bước gộp thời gian "đẹp" để biểu đồ có khoảng ≤ 40 điểm. */
function bucketSeconds(durationS) {
  return [1, 2, 5, 10, 15, 30, 60, 120, 300].find((b) => durationS / b <= 40) || 600;
}

function renderCharts() {
  const box = $('#charts');
  if (!box || !state.data) return;
  box.replaceChildren();
  const hasGaze = state.sessions.some((s) => s.eyeTracking) && state.data.some((s) => s.gaze.length);
  const kind = hasGaze ? 'gaze' : 'move';

  // 1. Mức chú ý theo thời gian trên trang đang xem
  const perSession = state.data.map((s) => ({ list: s[kind], start: s.events.length ? s.events[0].t : 0, end: s.events.length ? s.events[s.events.length - 1].t : 0 }));
  const durationS = Math.max(1, ...perSession.map((p) => (p.end - p.start) / 1000));
  const step = bucketSeconds(durationS);
  const buckets = new Array(Math.floor(durationS / step) + 1).fill(0);
  for (const p of perSession) {
    for (const e of p.list) {
      const b = Math.floor((e.t - p.start) / 1000 / step);
      if (b >= 0 && b < buckets.length) buckets[b]++;
    }
  }
  Charts.line(box, {
    title: t('chart.attention'),
    subtitle: t(kind === 'gaze' ? 'chart.attention_gaze' : 'chart.attention_move', { s: step }),
    points: buckets.map((y, i) => ({ x: i * step, y })),
    xLabel: (x) => fmtDuration(x * 1000),
    yLabel: (y) => t('chart.samples', { n: Charts.fmtNum(y) }),
    tableLabel: t('chart.table'),
    headers: [t('chart.col_time'), t('chart.col_value')],
    emptyText: t('chart.empty'),
  });

  // 2. Mức chú ý theo độ sâu trang (10 dải theo chiều cao trang)
  const dh = state.view.dh || 1;
  const bands = new Array(10).fill(0);
  let total = 0;
  for (const s of state.data) {
    for (const e of s[kind]) {
      bands[Math.min(9, Math.max(0, Math.floor((e.y / dh) * 10)))]++;
      total++;
    }
  }
  Charts.hbar(box, {
    title: t('chart.depth'),
    subtitle: t(kind === 'gaze' ? 'chart.depth_gaze' : 'chart.depth_move'),
    rows: bands.map((v, i) => ({ label: `${i * 10}–${(i + 1) * 10}%`, value: total ? (v / total) * 100 : 0 })),
    keepZero: true,
    valueLabel: (v) => t('chart.share', { n: v > 0 && v < 1 ? v.toFixed(1) : Math.round(v) }),
    tableLabel: t('chart.table'),
    headers: [t('chart.col_band'), t('chart.col_value')],
    emptyText: t('chart.empty'),
  });

  // 3. Phần tử được click nhiều trên trang đang xem
  const groups = new Map();
  for (const c of state.data.flatMap((d) => d.click)) {
    const el = c.el || {};
    const key = el.selector || el.tag || '?';
    const g = groups.get(key) || { label: el.text ? `"${el.text.slice(0, 50)}"` : key, full: el.text ? `"${el.text}" · ${key}` : key, value: 0 };
    g.value++;
    groups.set(key, g);
  }
  Charts.hbar(box, {
    title: t('chart.top_clicks'),
    subtitle: t('chart.top_clicks_sub'),
    rows: [...groups.values()].sort((a, b) => b.value - a.value).slice(0, 10),
    valueLabel: (v) => t(v === 1 ? 'chart.click_one' : 'chart.clicks', { n: v }),
    tableLabel: t('chart.table'),
    headers: [t('chart.col_element'), t('chart.col_value')],
    emptyText: t('report.no_clicks'),
  });

  // 4 & 5. Thời gian và số click trên từng trang (toàn phiên)
  const timeByPage = new Map();
  const clicksByPage = new Map();
  for (const s of state.sessions) {
    for (const v of visits(s.events)) timeByPage.set(v.page, (timeByPage.get(v.page) || 0) + (v.end - v.start) / 1000);
    for (const e of s.events) if (e.type === 'click' && e.page) clicksByPage.set(e.page, (clicksByPage.get(e.page) || 0) + 1);
  }
  const pageRows = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([p, v]) => ({ label: shortPage(p), full: p, value: v }));
  Charts.hbar(box, {
    title: t('chart.time_pages'),
    subtitle: t('chart.time_pages_sub'),
    rows: pageRows(timeByPage),
    valueLabel: (v) => fmtDuration(v * 1000),
    tableLabel: t('chart.table'),
    headers: [t('chart.col_page'), t('chart.col_value')],
    emptyText: t('chart.empty'),
  });
  Charts.hbar(box, {
    title: t('chart.clicks_pages'),
    subtitle: t('chart.clicks_pages_sub'),
    rows: pageRows(clicksByPage),
    valueLabel: (v) => t(v === 1 ? 'chart.click_one' : 'chart.clicks', { n: v }),
    tableLabel: t('chart.table'),
    headers: [t('chart.col_page'), t('chart.col_value')],
    emptyText: t('chart.empty'),
  });
}

// ---------- bản ghi màn hình / âm thanh ----------

function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1e3)) + ' KB';
}

function renderMedia() {
  const box = $('#mediaList');
  const list = (state.primary.media || []).filter((m) => m.size > 0);
  if (!list.length) {
    box.innerHTML = `<p class="muted small">${esc(t('report.no_recordings'))}</p>`;
    return;
  }
  let n = 0;
  box.innerHTML = list.map((m) => {
    const src = `/__et/api/sessions/${state.primary.id}/media/${encodeURIComponent(m.id)}`;
    const title = m.kind === 'screen' ? t('report.screen_rec', { n: ++n }) : t('report.audio_rec');
    const metaLine = t('report.rec_meta', { duration: fmtDuration(m.durationMs || 0), start: fmtDuration(m.startT || 0), size: fmtBytes(m.size) });
    const player = m.kind === 'screen'
      ? `<video controls preload="metadata" src="${src}"></video>`
      : `<audio controls preload="metadata" src="${src}"></audio>`;
    const dl = m.kind === 'screen'
      ? `<a class="btn" href="${src}?download=1">${esc(t('report.download_video'))} (.${esc(m.file.split('.').pop())})</a>`
      : `<a class="btn primary" href="/__et/transcript.html?id=${state.primary.id}&media=${encodeURIComponent(m.id)}">${esc(t('report.transcript'))}</a>
         <button type="button" data-wav="${esc(m.id)}">${esc(t('report.download_audio'))}</button>`;
    return `<div class="media-item">
      <b>${esc(title)}</b>
      <span class="small muted">${esc(metaLine)}</span>
      ${player}
      <div class="row">${dl}<button type="button" class="danger" data-del-media="${esc(m.id)}">${esc(t('report.delete_rec'))}</button></div>
    </div>`;
  }).join('');
}

$('#mediaList').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-media]');
  const wav = e.target.closest('[data-wav]');
  const base = `/__et/api/sessions/${state.primary.id}/media/`;
  if (del) {
    if (!confirm(t('report.delete_rec_confirm'))) return;
    await fetch(base + encodeURIComponent(del.dataset.delMedia), { method: 'DELETE' });
    state.primary.media = (state.primary.media || []).filter((m) => m.id !== del.dataset.delMedia);
    renderMedia();
  } else if (wav) {
    // Âm thanh được ghi bằng Opus → xuất WAV để mở được ở mọi nơi (QuickTime, Word, Zoom…)
    const label = wav.textContent;
    wav.disabled = true;
    wav.textContent = t('report.preparing');
    try {
      const samples = await EtMedia.decodeAudio(base + encodeURIComponent(wav.dataset.wav));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(EtMedia.wavBlob(samples));
      a.download = `heatmap-${state.primary.id}-${wav.dataset.wav}.wav`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } finally {
      wav.disabled = false;
      wav.textContent = label;
    }
  }
});

function renderHeader() {
  const p = state.primary;
  $('#sessionUrl').textContent = `${p.url} — ${p.participant || t('common.anonymous')} — ${new Date(p.createdAt).toLocaleString(I18N.locale())}`;
}

async function init() {
  await I18N.load();
  renderRangeLabels();
  if (!/^[a-f0-9]{16}$/.test(sessionId || '')) {
    document.querySelector('main').innerHTML = `<div class="card">${esc(t('report.missing_id'))} <a href="/__et/">${esc(t('common.back_home'))}</a></div>`;
    return;
  }
  try {
    state.primary = await getJson('/__et/api/sessions/' + sessionId);
  } catch (err) {
    document.querySelector('main').innerHTML = `<div class="card">${esc(t('report.load_failed', { msg: err.message }))}</div>`;
    return;
  }
  const p = state.primary;
  renderHeader();
  renderMedia();
  if (!p.eyeTracking) document.body.classList.add('no-eye');
  // mở từ "Báo cáo tất cả phiên" → xem heatmap gộp các phiên cùng link
  if (params.get('merge') === '1') $('#merge').checked = true;
  $('#exportJson').href = `/__et/api/sessions/${p.id}/export?format=json`;
  $('#exportCsv').href = `/__et/api/sessions/${p.id}/export?format=csv`;
  if (!p.eyeTracking) $('#layer').value = 'move';
  await loadSessions();
  fillPageSelect();
  showPage();
}

init();
