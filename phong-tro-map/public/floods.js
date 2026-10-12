'use strict';

/* global L, Filters, map, api, esc, mapClickHooks */

// Lớp điểm ngập do người dùng tự thêm: một điểm, hoặc một đoạn đường A–B (bám theo
// đường phố). Lưu trên server (/api/floods), bật / tắt hiển thị bằng ô trong bảng trên bản đồ.

const FLOOD_LEVELS = [
  { id: 'frequent', label: 'Thường xuyên', color: '#d13b3b' },
  { id: 'medium', label: 'Vừa', color: '#ec9f5b' },
  { id: 'light', label: 'Nhẹ', color: '#efd25f' },
  { id: 'unknown', label: 'Chưa phân loại', color: '#959ca6' },
];
const floodLevel = (id) => FLOOD_LEVELS.find((l) => l.id === id) || FLOOD_LEVELS[3];

// Vẽ dưới ghim tin đăng (markerPane = 600) nhưng trên nền bản đồ.
map.createPane('floods').style.zIndex = 450;

const floodLayer = L.layerGroup();
const floodDraft = L.layerGroup().addTo(map); // điểm A đang chọn khi nối A–B
const flood = { items: [], mode: null, a: null, level: 'frequent', busy: false };

// ---------- bảng điều khiển trên bản đồ ----------

const FloodControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const div = L.DomUtil.create('div', 'flood-ctl');
    div.innerHTML = `
      <label class="fc-toggle" title="Bật / tắt hiển thị điểm ngập trên bản đồ">
        <input type="checkbox" id="floodShow"> 🌊 Điểm ngập <b id="floodCount"></b>
      </label>
      <div class="fc-body" id="floodBody">
        <div class="fc-title">Mức độ ngập:</div>
        ${FLOOD_LEVELS.map((l) => `<label class="fc-level"><input type="radio" name="floodLevel" value="${l.id}"${l.id === flood.level ? ' checked' : ''}>
          <i style="background:${l.color}"></i> ${esc(l.label)}</label>`).join('')}
        <div class="fc-actions">
          <button type="button" data-fmode="point" title="Bấm 1 chỗ trên bản đồ để đặt điểm ngập">📍 Đặt điểm</button>
          <button type="button" data-fmode="line" title="Bấm điểm A rồi điểm B để vẽ đoạn đường ngập">〰 Nối A–B</button>
        </div>
        <div class="fc-hint" id="floodHint" hidden></div>
      </div>`;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    return div;
  },
});
map.addControl(new FloodControl());

const fc = {
  show: document.getElementById('floodShow'),
  body: document.getElementById('floodBody'),
  count: document.getElementById('floodCount'),
  hint: document.getElementById('floodHint'),
};

function loadVisible() {
  try { return localStorage.getItem('phongtro.floods') !== '0'; } catch { return true; }
}

function setVisible(on) {
  fc.show.checked = on;
  fc.body.hidden = !on;
  if (on) map.addLayer(floodLayer);
  else {
    map.removeLayer(floodLayer);
    setMode(null);
  }
  try { localStorage.setItem('phongtro.floods', on ? '1' : '0'); } catch { /* không bắt buộc */ }
}

fc.show.addEventListener('change', () => setVisible(fc.show.checked));
fc.body.addEventListener('change', (e) => {
  if (e.target.name === 'floodLevel') flood.level = e.target.value;
});
fc.body.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fmode]');
  if (b) setMode(flood.mode === b.dataset.fmode ? null : b.dataset.fmode);
});

function hint(text) {
  fc.hint.hidden = !text;
  fc.hint.textContent = text || '';
}

function setMode(mode) {
  flood.mode = mode;
  flood.a = null;
  floodDraft.clearLayers();
  map.getContainer().classList.toggle('drawing', Boolean(mode));
  document.querySelectorAll('.flood-ctl [data-fmode]').forEach((b) => b.classList.toggle('on', b.dataset.fmode === mode));
  if (mode === 'point') hint('Bấm vào bản đồ để đặt điểm ngập. Esc để huỷ.');
  else if (mode === 'line') hint('Bấm điểm A (đầu đoạn ngập). Esc để huỷ.');
  else hint('');
  if (mode) map.closePopup();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && flood.mode) setMode(null);
});

// ---------- thêm / sửa / xoá ----------

async function saveFlood(body) {
  const res = await fetch('/api/floods', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  flood.items = data.floods || [];
  renderFloods();
  return flood.items;
}

async function addFlood(item) {
  try {
    const items = await saveFlood({ op: 'add', level: flood.level, ...item });
    const added = items[items.length - 1];
    if (added) openFlood(added.id);
  } catch (err) {
    alert('Không lưu được điểm ngập: ' + err.message);
  }
}

// Bấm trên bản đồ khi đang ở chế độ thêm điểm ngập (app.js gọi các hook này trước).
mapClickHooks.push((e) => {
  if (!flood.mode || flood.busy) return Boolean(flood.mode);
  const p = [e.latlng.lat, e.latlng.lng];
  if (flood.mode === 'point') {
    setMode(null);
    addFlood({ type: 'point', coords: p });
  } else if (!flood.a) {
    flood.a = p;
    L.circleMarker(p, { pane: 'floods', radius: 7, color: '#fff', weight: 2, fillColor: floodLevel(flood.level).color, fillOpacity: 1 })
      .bindTooltip('A', { permanent: true, direction: 'top', className: 'fc-ab' })
      .addTo(floodDraft);
    hint('Bấm điểm B (cuối đoạn ngập). Esc để huỷ.');
  } else {
    drawLine(flood.a, p);
  }
  return true;
});

async function drawLine(a, b) {
  flood.busy = true;
  hint('Đang tìm đường đi từ A tới B…');
  let r;
  try {
    r = await api(`/api/route?from=${a.join(',')}&to=${b.join(',')}`);
  } catch (err) {
    flood.busy = false;
    hint(err.message);
    return;
  }
  flood.busy = false;
  setMode(null);
  await addFlood({ type: 'line', path: r.path, routed: r.routed });
  if (!r.routed) hint('Không tìm được đường đi theo đường phố, đã nối thẳng A–B.');
}

function openFlood(id) {
  floodLayer.eachLayer((l) => {
    if (l.floodId === id) l.openPopup(l.getCenter ? l.getCenter() : l.getLatLng());
  });
}

function floodPopupHtml(f) {
  const isLine = f.type === 'line';
  const center = isLine ? f.path[Math.floor(f.path.length / 2)] : f.coords;
  const title = isLine ? `Đoạn ngập · ${Filters.formatDistance(Filters.pathLength(f.path))}` : 'Điểm ngập';
  return `<div class="popup flood-pop" data-flood="${esc(f.id)}">
    <div class="fp-title"><i style="background:${floodLevel(f.level).color}"></i> ${title}</div>
    <label>Mức độ
      <select data-flood-level>${FLOOD_LEVELS.map((l) => `<option value="${l.id}"${l.id === f.level ? ' selected' : ''}>${esc(l.label)}</option>`).join('')}</select>
    </label>
    <label>Ghi chú
      <input data-flood-note maxlength="300" value="${esc(f.note || '')}" placeholder="vd. ngập ~30 cm khi mưa lớn">
    </label>
    <div class="fp-actions">
      <a href="${esc(Filters.googleMapsUrl(center[0], center[1]))}" target="_blank" rel="noopener">📍 Google Maps</a>
      <button type="button" data-flood-del>Xoá</button>
    </div>
  </div>`;
}

function renderFloods() {
  floodLayer.clearLayers();
  for (const f of flood.items) {
    const color = floodLevel(f.level).color;
    const layer = f.type === 'line'
      ? L.polyline(f.path, { pane: 'floods', color, weight: 7, opacity: 0.85, lineCap: 'round', lineJoin: 'round', bubblingMouseEvents: false })
      : L.circleMarker(f.coords, { pane: 'floods', radius: 9, color: '#fff', weight: 2, fillColor: color, fillOpacity: 0.95, bubblingMouseEvents: false });
    layer.floodId = f.id;
    layer.bindPopup(() => floodPopupHtml(f), { minWidth: 220 });
    layer.bindTooltip(`🌊 ${esc(floodLevel(f.level).label)}${f.note ? ' · ' + esc(f.note) : ''}`, { sticky: true });
    floodLayer.addLayer(layer);
  }
  fc.count.textContent = flood.items.length ? String(flood.items.length) : '';
}

function floodIdOf(el) {
  return el.closest('[data-flood]')?.dataset.flood;
}

document.addEventListener('change', (e) => {
  const id = floodIdOf(e.target);
  if (!id) return;
  if (e.target.matches('[data-flood-level]')) {
    saveFlood({ op: 'update', id, level: e.target.value }).then(() => openFlood(id)).catch((err) => alert(err.message));
  } else if (e.target.matches('[data-flood-note]')) {
    saveFlood({ op: 'update', id, note: e.target.value }).catch((err) => alert(err.message));
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-flood-note]')) e.target.blur();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-flood-del]')) return;
  const id = floodIdOf(e.target);
  if (!id || !confirm('Xoá điểm ngập này?')) return;
  map.closePopup();
  saveFlood({ op: 'remove', id }).catch((err) => alert(err.message));
});

// ---------- khởi động ----------

setVisible(loadVisible());
api('/api/floods').then((d) => {
  flood.items = d.floods || [];
  renderFloods();
}).catch(() => { /* chưa có dữ liệu */ });
