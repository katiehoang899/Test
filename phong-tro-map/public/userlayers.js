'use strict';

/* global L, Filters, map, api, esc, icon, mapClickHooks */

// Lớp bản đồ do người dùng tự thêm: điểm ngập, chỗ đỗ xe hơi. Mỗi lớp có bảng điều khiển
// riêng trên bản đồ (bật / tắt, chú thích loại, "Đặt điểm", "Nối A–B"); đoạn A–B bám theo
// đường phố (/api/route). Dữ liệu lưu trên server: /api/floods, /api/parking.

const USER_LAYERS = [
  {
    key: 'floods',
    icon: 'drop',
    title: 'Điểm ngập',
    legend: 'Mức độ ngập',
    what: 'điểm ngập',
    pointTitle: 'Điểm ngập',
    lineTitle: 'Đoạn ngập',
    notePlaceholder: 'vd. ngập ~30 cm khi mưa lớn',
    zIndex: 450,
    levels: [
      { id: 'frequent', label: 'Thường xuyên', color: '#d13b3b' },
      { id: 'medium', label: 'Vừa', color: '#ec9f5b' },
      { id: 'light', label: 'Nhẹ', color: '#efd25f' },
      { id: 'unknown', label: 'Chưa phân loại', color: '#959ca6' },
    ],
  },
  {
    key: 'parking',
    icon: 'car',
    title: 'Đỗ xe hơi',
    legend: 'Loại chỗ đỗ',
    what: 'điểm đỗ xe hơi',
    pointTitle: 'Điểm đỗ xe hơi',
    lineTitle: 'Đoạn đỗ xe hơi',
    notePlaceholder: 'vd. đỗ được sau 18h, 30k/lượt',
    zIndex: 460,
    badge: 'P', // điểm vẽ dạng biển "P" xanh dương (chấm màu ở góc là loại chỗ đỗ)
    dash: '12 8', // đoạn A–B vẽ nét đứt để phân biệt với đoạn ngập
    levels: [
      { id: 'free', label: 'Miễn phí', color: '#2e9d58' },
      { id: 'paid', label: 'Có thu phí', color: '#e8871e' },
      { id: 'limited', label: 'Giới hạn giờ', color: '#8e5bd0' },
      { id: 'unknown', label: 'Chưa phân loại', color: '#959ca6' },
    ],
  },
];

let activeLayer = null; // lớp đang ở chế độ đặt điểm / nối A–B (chỉ một lớp một lúc)

function createUserLayer(cfg) {
  const levelOf = (id) => cfg.levels.find((l) => l.id === id) || cfg.levels[cfg.levels.length - 1];
  map.createPane(cfg.key).style.zIndex = cfg.zIndex; // dưới ghim tin đăng (markerPane = 600)
  const group = L.layerGroup();
  const draft = L.layerGroup().addTo(map); // điểm A đang chọn khi nối A–B
  // Điểm / đoạn mới là "Chưa phân loại"; popup mở ngay sau khi đặt để chọn mức độ / loại.
  const st = { items: [], mode: null, a: null, level: cfg.levels[cfg.levels.length - 1].id, busy: false };

  // ---------- bảng điều khiển ----------

  const Control = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const div = L.DomUtil.create('div', 'ul-ctl');
      div.dataset.layer = cfg.key;
      div.innerHTML = `
        <label class="ul-toggle" title="Bật / tắt hiển thị ${esc(cfg.what)} trên bản đồ">
          <input type="checkbox" data-ul-show> ${icon(cfg.icon)} <span class="tx">${esc(cfg.title)}</span> <b data-ul-count></b>
        </label>
        <div class="ul-body" data-ul-body>
          <div class="ul-actions">
            <button type="button" data-ul-mode="point" title="Bấm 1 chỗ trên bản đồ để đặt ${esc(cfg.what)}">${icon('pinPlus')} Đặt điểm</button>
            <button type="button" data-ul-mode="line" title="Bấm điểm A rồi điểm B để vẽ một đoạn đường">${icon('route')} Nối A–B</button>
          </div>
          <div class="ul-hint" data-ul-hint hidden></div>
        </div>`;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    },
  });
  const ctl = new Control();
  map.addControl(ctl);
  const root = ctl.getContainer();
  const ui = {
    show: root.querySelector('[data-ul-show]'),
    body: root.querySelector('[data-ul-body]'),
    count: root.querySelector('[data-ul-count]'),
    hint: root.querySelector('[data-ul-hint]'),
  };
  const storeKey = `phongtro.layer.${cfg.key}`;

  function setVisible(on) {
    ui.show.checked = on;
    ui.body.hidden = !on;
    if (on) map.addLayer(group);
    else {
      map.removeLayer(group);
      if (st.mode) setMode(null);
    }
    try { localStorage.setItem(storeKey, on ? '1' : '0'); } catch { /* không bắt buộc */ }
  }

  function hint(text) {
    ui.hint.hidden = !text;
    ui.hint.textContent = text || '';
  }

  function setMode(mode) {
    if (mode && activeLayer && activeLayer !== api_) activeLayer.setMode(null);
    activeLayer = mode ? api_ : (activeLayer === api_ ? null : activeLayer);
    st.mode = mode;
    st.a = null;
    draft.clearLayers();
    map.getContainer().classList.toggle('drawing', Boolean(activeLayer));
    root.querySelectorAll('[data-ul-mode]').forEach((b) => b.classList.toggle('on', b.dataset.ulMode === mode));
    if (mode === 'point') hint(`Bấm vào bản đồ để đặt ${cfg.what}. Esc để huỷ.`);
    else if (mode === 'line') hint('Bấm điểm A (đầu đoạn). Esc để huỷ.');
    else hint('');
    if (mode) map.closePopup();
  }

  ui.show.addEventListener('change', () => setVisible(ui.show.checked));
  ui.body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ul-mode]');
    if (b) setMode(st.mode === b.dataset.ulMode ? null : b.dataset.ulMode);
  });

  // ---------- thêm / sửa / xoá ----------

  async function save(body) {
    const res = await fetch(`/api/${cfg.key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
    st.items = data[cfg.key] || [];
    render();
    return st.items;
  }

  async function add(item) {
    try {
      const items = await save({ op: 'add', level: st.level, ...item });
      const added = items[items.length - 1];
      if (added) open(added.id);
    } catch (err) {
      alert(`Không lưu được ${cfg.what}: ${err.message}`);
    }
  }

  function onMapClick(e) {
    if (!st.mode || st.busy) return Boolean(st.mode);
    const p = [e.latlng.lat, e.latlng.lng];
    if (st.mode === 'point') {
      setMode(null);
      add({ type: 'point', coords: p });
    } else if (!st.a) {
      st.a = p;
      L.circleMarker(p, { pane: cfg.key, radius: 7, color: '#fff', weight: 2, fillColor: levelOf(st.level).color, fillOpacity: 1 })
        .bindTooltip('A', { permanent: true, direction: 'top', className: 'ul-ab' })
        .addTo(draft);
      hint('Bấm điểm B (cuối đoạn). Esc để huỷ.');
    } else {
      drawLine(st.a, p);
    }
    return true;
  }

  async function drawLine(a, b) {
    st.busy = true;
    hint('Đang tìm đường đi từ A tới B…');
    let r;
    try {
      r = await api(`/api/route?from=${a.join(',')}&to=${b.join(',')}`);
    } catch (err) {
      st.busy = false;
      hint(err.message);
      return;
    }
    st.busy = false;
    setMode(null);
    await add({ type: 'line', path: r.path, routed: r.routed });
    if (!r.routed) hint('Không tìm được đường đi theo đường phố, đã nối thẳng A–B.');
  }

  function open(id) {
    group.eachLayer((l) => {
      if (l.itemId === id) l.openPopup(l.getCenter ? l.getCenter() : l.getLatLng());
    });
  }

  function popupHtml(f) {
    const isLine = f.type === 'line';
    const center = isLine ? f.path[Math.floor(f.path.length / 2)] : f.coords;
    const title = isLine ? `${cfg.lineTitle} · ${Filters.formatDistance(Filters.pathLength(f.path))}` : cfg.pointTitle;
    return `<div class="popup ul-pop" data-ul-item="${esc(f.id)}" data-ul-layer="${cfg.key}">
      <div class="up-title"><i style="background:${levelOf(f.level).color}"></i> ${icon(cfg.icon)} ${esc(title)}</div>
      <label>${esc(cfg.legend)}
        <select data-ul-level>${cfg.levels.map((l) => `<option value="${l.id}"${l.id === f.level ? ' selected' : ''}>${esc(l.label)}</option>`).join('')}</select>
      </label>
      <label>Ghi chú
        <input data-ul-note maxlength="300" value="${esc(f.note || '')}" placeholder="${esc(cfg.notePlaceholder)}">
      </label>
      <div class="up-actions">
        <a href="${esc(Filters.googleMapsUrl(center[0], center[1]))}" target="_blank" rel="noopener">${icon('pin')} Google Maps</a>
        <button type="button" data-ul-del>${icon('trash')} Xoá</button>
      </div>
    </div>`;
  }

  function pointLayer(f, color) {
    const opts = { pane: cfg.key, bubblingMouseEvents: false };
    if (!cfg.badge) {
      return L.circleMarker(f.coords, { ...opts, radius: 9, color: '#fff', weight: 2, fillColor: color, fillOpacity: 0.95 });
    }
    const icon = L.divIcon({
      className: 'ul-badge',
      html: `<span>${esc(cfg.badge)}<i style="background:${color}"></i></span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -12],
    });
    return L.marker(f.coords, { ...opts, icon, keyboard: false });
  }

  function render() {
    group.clearLayers();
    for (const f of st.items) {
      const color = levelOf(f.level).color;
      const layer = f.type === 'line'
        ? L.polyline(f.path, { pane: cfg.key, color, weight: 7, opacity: 0.85, dashArray: cfg.dash, lineCap: 'round', lineJoin: 'round', bubblingMouseEvents: false })
        : pointLayer(f, color);
      layer.itemId = f.id;
      layer.bindPopup(() => popupHtml(f), { minWidth: 220 });
      layer.bindTooltip(`${icon(cfg.icon)} ${esc(levelOf(f.level).label)}${f.note ? ' · ' + esc(f.note) : ''}`, { sticky: true });
      group.addLayer(layer);
    }
    ui.count.textContent = st.items.length ? String(st.items.length) : '';
  }

  const api_ = { key: cfg.key, cfg, setMode, save, open, onMapClick, mode: () => st.mode };

  let visible = true;
  try { visible = localStorage.getItem(storeKey) !== '0'; } catch { /* bỏ qua */ }
  setVisible(visible);
  api(`/api/${cfg.key}`).then((d) => {
    st.items = d[cfg.key] || [];
    render();
  }).catch(() => { /* chưa có dữ liệu */ });
  return api_;
}

const userLayers = Object.fromEntries(USER_LAYERS.map((cfg) => [cfg.key, createUserLayer(cfg)]));

// Bấm trên bản đồ khi một lớp đang ở chế độ đặt điểm / nối A–B (app.js gọi hook này trước).
mapClickHooks.push((e) => (activeLayer ? activeLayer.onMapClick(e) : false));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeLayer) activeLayer.setMode(null);
  if (e.key === 'Enter' && e.target.matches('[data-ul-note]')) e.target.blur();
});

// Sửa / xoá trong popup (popup không nằm trong bảng điều khiển nên bắt ở document).
function popupTarget(el) {
  const box = el.closest('[data-ul-item]');
  return box ? { layer: userLayers[box.dataset.ulLayer], id: box.dataset.ulItem } : null;
}

document.addEventListener('change', (e) => {
  const t = popupTarget(e.target);
  if (!t) return;
  if (e.target.matches('[data-ul-level]')) {
    t.layer.save({ op: 'update', id: t.id, level: e.target.value }).then(() => t.layer.open(t.id)).catch((err) => alert(err.message));
  } else if (e.target.matches('[data-ul-note]')) {
    t.layer.save({ op: 'update', id: t.id, note: e.target.value }).catch((err) => alert(err.message));
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-ul-del]')) return;
  const t = popupTarget(e.target);
  if (!t || !confirm(`Xoá ${t.layer.cfg.what} này?`)) return;
  map.closePopup();
  t.layer.save({ op: 'remove', id: t.id }).catch((err) => alert(err.message));
});
