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
  frameWin: null,
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
  return s >= 60 ? `${Math.floor(s / 60)}p ${s % 60}s` : `${s}s`;
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
  const all = await getJson('/api/sessions');
  const same = all.filter((s) => s.url === state.primary.url && s.id !== state.primary.id);
  const others = await Promise.all(same.map((s) => getJson('/api/sessions/' + s.id).catch(() => null)));
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
  try {
    return { sx: state.frameWin.scrollX, sy: state.frameWin.scrollY };
  } catch {
    return { sx: 0, sy: 0 };
  }
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
  try {
    state.frameWin.scrollTo(0, Math.max(0, y));
  } catch {
    // iframe không truy cập được
  }
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
    ['Số phiên', d.length],
    ['Thời gian trên trang', fmtDuration(time)],
    ['Khung nhìn', `${state.view.vw}×${state.view.vh}`],
    ['Mẫu ánh mắt', gazeN],
    ['Số điểm dừng mắt', fixN],
    ['Thời gian dừng TB', fixN ? Math.round(fixDur / fixN) + 'ms' : '—'],
    ['Ánh mắt trên màn hình đầu', gazeN ? Math.round((aboveFold / gazeN) * 100) + '%' : '—'],
    ['Thời điểm nhìn đầu tiên', firstFix && d[0].visits[0] ? (Math.max(0, firstFix.t - d[0].visits[0].start) / 1000).toFixed(1) + 's' : '—'],
    ['Số click', sum((s) => s.click.length)],
    ['Độ sâu cuộn tối đa', Math.round(maxDepth) + '%'],
    ['Độ chính xác hiệu chỉnh', calib && calib.accuracy != null ? Math.round(calib.accuracy) + '%' : '—'],
  ];
  $('#stats').innerHTML = rows.map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');

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
    : '<li class="muted" style="list-style: none; margin-left: -18px">Chưa có click nào.</li>';
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

function loadFrame() {
  state.frameWin = null;
  frame.src = '/proxy?url=' + encodeURIComponent(state.page);
}

frame.addEventListener('load', () => {
  try {
    const win = frame.contentWindow;
    void win.document.body;
    state.frameWin = win;
    // Báo cáo chỉ để xem: chặn click/submit để trang không chuyển đi nơi khác.
    win.addEventListener('click', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
    win.addEventListener('submit', (e) => e.preventDefault(), true);
    win.addEventListener('scroll', redraw, { passive: true });
  } catch {
    state.frameWin = null;
  }
  syncReplayScroll();
  redraw();
});

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
  if (!Number.isFinite(state.time) || !state.frameWin || state.data.length > 1) return;
  const e = lastBefore(state.data[0].scroll, state.time);
  if (e) {
    try {
      state.frameWin.scrollTo(e.sx || 0, e.sy || 0);
    } catch {
      // bỏ qua
    }
  }
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
  $('#play').textContent = '▶ Phát lại';
}

$('#play').addEventListener('click', () => {
  if (state.playing) return stopPlay();
  state.playing = true;
  $('#play').textContent = '❚❚ Dừng';
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
  sel.innerHTML = [...counts].map(([p, n]) => `<option value="${esc(p)}">${esc(p)} (${n} lượt)</option>`).join('');
  if (state.page && counts.has(state.page)) sel.value = state.page;
  state.page = sel.value;
}

function showPage() {
  stopPlay();
  buildPageData();
  layoutStage();
  updateTimeline();
  renderStats();
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

for (const id of ['#layer', '#radius', '#opacity', '#showClicks']) {
  $(id).addEventListener('input', () => {
    $('#radiusVal').textContent = $('#radius').value;
    $('#opacityVal').textContent = $('#opacity').value;
    redraw();
  });
}

window.addEventListener('resize', () => {
  if (!state.view) return;
  layoutStage();
  redraw();
});

async function init() {
  $('#radiusVal').textContent = $('#radius').value;
  $('#opacityVal').textContent = $('#opacity').value;
  if (!/^[a-f0-9]{16}$/.test(sessionId || '')) {
    document.querySelector('main').innerHTML = '<div class="card">Thiếu mã phiên. <a href="/">Quay lại</a></div>';
    return;
  }
  try {
    state.primary = await getJson('/api/sessions/' + sessionId);
  } catch (err) {
    document.querySelector('main').innerHTML = `<div class="card">Không tải được phiên: ${esc(err.message)}</div>`;
    return;
  }
  const p = state.primary;
  $('#sessionUrl').textContent = `${p.url} — ${p.participant || 'ẩn danh'} — ${new Date(p.createdAt).toLocaleString('vi-VN')}`;
  $('#exportJson').href = `/api/sessions/${p.id}/export?format=json`;
  $('#exportCsv').href = `/api/sessions/${p.id}/export?format=csv`;
  if (!p.eyeTracking) $('#layer').value = 'move';
  await loadSessions();
  fillPageSelect();
  showPage();
}

init();
