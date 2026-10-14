'use strict';

/* global L, Filters, map, api, esc, icon, mapClickHooks */

// Lớp bản đồ do người dùng tự thêm: điểm ngập, chỗ đỗ xe hơi. Mỗi lớp có bảng điều khiển
// riêng trên bản đồ (bật / tắt, chú thích loại, "Đặt điểm", "Nối A–B"); đoạn A–B bám theo
// đường phố (/api/route). Dữ liệu lưu trên server: /api/floods, /api/parking.

const USER_LAYERS = [
  {
    key: 'floods',
    file: 'diem-ngap', // tên file sao lưu
    icon: 'drop',
    title: 'Điểm ngập',
    legend: 'Mức độ ngập',
    what: 'điểm ngập',
    pointTitle: 'Điểm ngập',
    lineTitle: 'Đoạn ngập',
    notePlaceholder: 'vd. ngập ~30 cm khi mưa lớn',
    zIndex: 450,
    color: '#d92d2d', // mọi điểm / đoạn ngập màu đỏ; mức độ ngập ghi trong chữ (tooltip, popup, danh sách)
    levels: [
      { id: 'frequent', label: 'Thường xuyên' },
      { id: 'medium', label: 'Vừa' },
      { id: 'light', label: 'Nhẹ' },
      { id: 'unknown', label: 'Chưa phân loại' },
    ],
  },
  {
    key: 'parking',
    file: 'do-xe-hoi',
    icon: 'car',
    title: 'Đỗ xe hơi',
    legend: 'Loại chỗ đỗ',
    what: 'điểm đỗ xe hơi',
    pointTitle: 'Điểm đỗ xe hơi',
    lineTitle: 'Đoạn đỗ xe hơi',
    notePlaceholder: 'vd. đỗ được sau 18h, 30k/lượt',
    zIndex: 460,
    color: '#1f9a4a', // mọi biển P / đoạn đỗ xe màu xanh lá; loại chỗ đỗ ghi trong chữ
    badge: 'P', // điểm vẽ dạng biển "P"
    dash: '12 8', // đoạn A–B vẽ nét đứt để phân biệt với đoạn ngập
    levels: [
      { id: 'free', label: 'Miễn phí' },
      { id: 'paid', label: 'Có thu phí' },
      { id: 'limited', label: 'Giới hạn giờ' },
      { id: 'unknown', label: 'Chưa phân loại' },
    ],
  },
];

let activeLayer = null;

// Mọi chấm / đường của các lớp vẽ chung MỘT canvas: mỗi canvas phủ kín bản đồ và chỉ nhận
// chuột cho hình của chính nó, nên nếu mỗi lớp một canvas thì canvas trên cùng (đỗ xe) che
// mất lớp dưới (điểm ngập): không rê / bấm được. tolerance: nới vùng bắt chuột ra 6px.
map.createPane('userVectors').style.zIndex = 450; // dưới ghim tin đăng (markerPane = 600)
const vectorRenderer = L.canvas({ pane: 'userVectors', tolerance: 6 });
const VECTOR = { pane: 'userVectors', renderer: vectorRenderer }; // lớp đang ở chế độ đặt điểm / nối A–B (chỉ một lớp một lúc)

function createUserLayer(cfg) {
  const levelOf = (id) => cfg.levels.find((l) => l.id === id) || cfg.levels[cfg.levels.length - 1];
  map.createPane(cfg.key).style.zIndex = cfg.zIndex; // biển P (phần tử HTML), dưới ghim tin đăng
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
        <div class="ul-head">
          <label class="ul-toggle" title="Bật / tắt hiển thị ${esc(cfg.what)} trên bản đồ">
            <input type="checkbox" data-ul-show> ${icon(cfg.icon)} <span class="tx">${esc(cfg.title)}</span>
          </label>
          <button type="button" class="ul-list-btn" data-ul-list title="Danh sách ${esc(cfg.what)} đã tạo: xem, sửa, xoá"
            aria-label="Danh sách ${esc(cfg.what)} đã tạo">${icon('list')} <b data-ul-count>0</b></button>
        </div>
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
    listBtn: root.querySelector('[data-ul-list]'),
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
  ui.listBtn.addEventListener('click', () => openList(api_));
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
    if (listDlg.open && listLayer === api_) renderLayerList();
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
      L.circleMarker(p, { ...VECTOR, radius: 7, color: '#fff', weight: 2, fillColor: cfg.color, fillOpacity: 1 })
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

  // Tới điểm / đoạn trên bản đồ (bật lớp nếu đang tắt) rồi mở popup của nó.
  function focus(id) {
    const f = st.items.find((x) => x.id === id);
    if (!f) return;
    if (!ui.show.checked) setVisible(true);
    if (f.type === 'line') map.fitBounds(L.latLngBounds(f.path).pad(0.25), { animate: false, maxZoom: 17 });
    else map.setView(f.coords, Math.max(map.getZoom(), 17), { animate: false });
    open(id);
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
      <div class="up-title"><i style="background:${cfg.color}"></i> ${icon(cfg.icon)} ${esc(title)}</div>
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

  function pointLayer(f) {
    if (!cfg.badge) {
      return L.circleMarker(f.coords, { ...VECTOR, bubblingMouseEvents: false, radius: 9, color: '#fff', weight: 2, fillColor: cfg.color, fillOpacity: 0.95 });
    }
    const badgeIcon = L.divIcon({
      className: 'ul-badge',
      html: `<span style="background:${cfg.color}">${esc(cfg.badge)}</span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -12],
    });
    return L.marker(f.coords, { pane: cfg.key, bubblingMouseEvents: false, icon: badgeIcon, keyboard: false });
  }

  function render() {
    group.clearLayers();
    for (const f of st.items) {
      const isLine = f.type === 'line';
      const layer = isLine
        ? L.polyline(f.path, { ...VECTOR, color: cfg.color, weight: 7, opacity: 0.85, dashArray: cfg.dash, lineCap: 'round', lineJoin: 'round', bubblingMouseEvents: false })
        : pointLayer(f);
      layer.itemId = f.id;
      layer.bindPopup(() => popupHtml(f), { minWidth: 220 });
      // Rê chuột: hiện tên lớp, mức độ / loại, ghi chú; làm nổi chấm / đường đang trỏ.
      layer.bindTooltip(`${icon(cfg.icon)} <b>${esc(isLine ? cfg.lineTitle : cfg.pointTitle)}</b> · ${esc(levelOf(f.level).label)}${f.note ? `<br>${esc(f.note)}` : ''}`,
        { sticky: true, direction: 'top', offset: [0, -8], className: 'ul-tip' });
      if (layer.setStyle) {
        const base = isLine ? { weight: 7, opacity: 0.85 } : { radius: 9, weight: 2 };
        layer.on('mouseover', () => { layer.setStyle(isLine ? { weight: 10, opacity: 1 } : { weight: 3 }); if (!isLine) layer.setRadius(11); });
        layer.on('mouseout', () => { layer.setStyle(base); if (!isLine) layer.setRadius(9); });
      }
      group.addLayer(layer);
    }
    ui.count.textContent = String(st.items.length);
  }

  // Thay cả danh sách (sau khi mở file sao lưu).
  function setItems(items) {
    st.items = items;
    render();
    if (listDlg.open && listLayer === api_) renderLayerList();
  }

  const api_ = { key: cfg.key, cfg, levelOf, setMode, save, setItems, open, focus, onMapClick, mode: () => st.mode, items: () => st.items };

  let visible = true;
  try { visible = localStorage.getItem(storeKey) !== '0'; } catch { /* bỏ qua */ }
  setVisible(visible);
  api(`/api/${cfg.key}`).then((d) => {
    st.items = d[cfg.key] || [];
    render();
  }).catch(() => { /* chưa có dữ liệu */ });
  return api_;
}

// ---------- danh sách điểm / đoạn đã tạo (popup) ----------

const listDlg = document.createElement('dialog');
listDlg.className = 'ul-dlg';
document.body.append(listDlg);
let listLayer = null;
let listImport = null; // file sao lưu vừa mở, chờ chọn Gộp / Thay thế: { key, name, items, exportedAt }
let listNotice = null; // { text, error } dòng thông báo trong danh sách

function openList(layer) {
  listImport = null; // mở lại danh sách: bỏ thông báo / file đang chờ của lần trước
  listNotice = null;
  listLayer = layer;
  renderLayerList();
  if (!listDlg.open) listDlg.showModal();
}

function shortTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getDate()}/${d.getMonth() + 1} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderLayerList() {
  const layer = listLayer;
  const { cfg } = layer;
  const items = layer.items().slice().sort((a, b) => b.at - a.at);
  const rows = items.map((f) => {
    const isLine = f.type === 'line';
    const kind = isLine ? `Đoạn A–B · ${Filters.formatDistance(Filters.pathLength(f.path))}` : 'Điểm';
    return `<li class="ul-row" data-ul-item="${esc(f.id)}" data-ul-layer="${cfg.key}">
      <i class="ul-dot" style="background:${cfg.color}"></i>
      <div class="ul-row-main">
        <div class="ul-row-title">${icon(isLine ? 'route' : 'pin')} <span>${esc(kind)}</span>${f.at ? `<span class="ul-row-time">${esc(shortTime(f.at))}</span>` : ''}</div>
        <div class="ul-row-fields">
          <select data-ul-level aria-label="${esc(cfg.legend)}">${cfg.levels.map((l) => `<option value="${l.id}"${l.id === f.level ? ' selected' : ''}>${esc(l.label)}</option>`).join('')}</select>
          <input data-ul-note maxlength="300" value="${esc(f.note || '')}" placeholder="Ghi chú: ${esc(cfg.notePlaceholder)}" aria-label="Ghi chú">
        </div>
      </div>
      <div class="ul-row-acts">
        <button type="button" data-ul-goto title="Xem trên bản đồ">${icon('pin')} Xem</button>
        <button type="button" data-ul-del class="danger" title="Xoá">${icon('trash')} Xoá</button>
      </div>
    </li>`;
  }).join('');
  const imp = listImport && listImport.key === cfg.key ? listImport : null;
  listDlg.innerHTML = `<div class="ul-dlg-head">
      <h2>${icon(cfg.icon)} ${esc(cfg.title)} <b>${items.length}</b></h2>
      <button type="button" class="ul-dlg-close" data-ul-close aria-label="Đóng">${icon('close')}</button>
    </div>
    <div class="ul-dlg-tools">
      <button type="button" data-ul-export${items.length ? '' : ' disabled'} title="Lưu danh sách ${esc(cfg.what)} ra file (.json) để sao lưu, dùng lại về sau">${icon('download')} Sao lưu ra file</button>
      <button type="button" data-ul-import title="Mở file sao lưu ${esc(cfg.what)} để cập nhật danh sách">${icon('upload')} Mở file sao lưu</button>
      <input type="file" accept=".json,application/json" data-ul-file hidden>
    </div>
    ${imp ? `<div class="ul-import">
      <p>File <b>${esc(imp.name)}</b> có <b>${imp.items.length}</b> ${esc(cfg.what)}${imp.exportedAt ? ` (sao lưu lúc ${esc(shortTime(imp.exportedAt))})` : ''}. Cập nhật danh sách thế nào?</p>
      <div class="ul-import-acts">
        <button type="button" class="primary" data-ul-import-mode="merge" title="Thêm điểm mới trong file; điểm đã có thì cập nhật theo file. Không xoá điểm nào.">Gộp vào danh sách</button>
        <button type="button" data-ul-import-mode="replace" title="Xoá danh sách hiện tại, chỉ giữ các điểm trong file">Thay thế toàn bộ${items.length ? ` (${items.length} điểm hiện có sẽ bị xoá)` : ''}</button>
        <button type="button" data-ul-import-cancel>Huỷ</button>
      </div>
    </div>` : ''}
    ${listNotice ? `<p class="ul-notice${listNotice.error ? ' error' : ''}" role="status">${esc(listNotice.text)}</p>` : ''}
    ${items.length
    ? `<ul class="ul-rows">${rows}</ul>`
    : `<p class="ul-empty">Chưa có ${esc(cfg.what)} nào. Bấm <b>Đặt điểm</b> hoặc <b>Nối A–B</b> trong bảng ${esc(cfg.title)} trên bản đồ để thêm.</p>`}`;
}

// ---------- sao lưu ra file / mở file sao lưu ----------

function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function exportLayer(layer) {
  const { cfg } = layer;
  const items = layer.items();
  const data = { app: 'phong-tro-map', layer: cfg.key, name: cfg.title, version: 1, exportedAt: new Date().toISOString(), count: items.length, items };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `phong-tro-map-${cfg.file}-${dateStamp()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  listNotice = { text: `Đã lưu ${items.length} ${cfg.what} ra file ${a.download}.` };
  renderLayerList();
}

// Đọc file sao lưu: { layer, items } (file do tool tạo) hoặc chỉ là một mảng điểm.
async function readBackup(file, cfg) {
  if (file.size > 16 * 1024 * 1024) throw new Error('File quá lớn (tối đa 16 MB).');
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('File không đúng định dạng sao lưu (.json).'); }
  const items = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(items)) throw new Error('File không có danh sách điểm.');
  if (!Array.isArray(data) && data.layer && data.layer !== cfg.key) {
    const other = USER_LAYERS.find((c) => c.key === data.layer);
    throw new Error(`File này là danh sách ${other ? other.title : data.layer}, hãy mở trong danh sách ${other ? other.title : 'tương ứng'}.`);
  }
  const at = Date.parse(data.exportedAt);
  return { key: cfg.key, name: file.name, items, exportedAt: Number.isFinite(at) ? at : null };
}

listDlg.addEventListener('change', async (e) => {
  if (!e.target.matches('[data-ul-file]')) return;
  const file = e.target.files[0];
  if (!file) return;
  try {
    listImport = await readBackup(file, listLayer.cfg);
    listNotice = listImport.items.length ? null : { text: 'File không có điểm nào.', error: true };
    if (!listImport.items.length) listImport = null;
  } catch (err) {
    listImport = null;
    listNotice = { text: err.message, error: true };
  }
  renderLayerList();
});

async function applyImport(mode) {
  const layer = listLayer;
  const imp = listImport;
  if (!imp || imp.key !== layer.cfg.key) return;
  if (mode === 'replace' && layer.items().length && !confirm(`Thay toàn bộ ${layer.items().length} ${layer.cfg.what} hiện có bằng ${imp.items.length} ${layer.cfg.what} trong file?`)) return;
  try {
    const res = await fetch(`/api/${layer.cfg.key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'import', mode, items: imp.items }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
    listImport = null;
    listNotice = { text: `Đã ${mode === 'replace' ? 'thay danh sách bằng' : 'gộp'} ${data.imported} ${layer.cfg.what} từ file${data.skipped ? `, bỏ qua ${data.skipped} mục không hợp lệ` : ''}.` };
    layer.setItems(data[layer.cfg.key] || []);
  } catch (err) {
    listNotice = { text: 'Không mở được file: ' + err.message, error: true };
    renderLayerList();
  }
}

listDlg.addEventListener('click', (e) => {
  // Bấm nút × hoặc ra ngoài khung (vùng nền mờ) thì đóng.
  if (e.target === listDlg || e.target.closest('[data-ul-close]')) return listDlg.close();
  if (e.target.closest('[data-ul-export]')) return exportLayer(listLayer);
  if (e.target.closest('[data-ul-import]')) return listDlg.querySelector('[data-ul-file]').click();
  const mode = e.target.closest('[data-ul-import-mode]');
  if (mode) return applyImport(mode.dataset.ulImportMode);
  if (e.target.closest('[data-ul-import-cancel]')) { listImport = null; return renderLayerList(); }
  const go = e.target.closest('[data-ul-goto]');
  if (go) {
    const t = popupTarget(go);
    listDlg.close();
    t.layer.focus(t.id);
  }
});

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
    const inList = Boolean(e.target.closest('.ul-dlg')); // sửa trong danh sách: không mở popup trên bản đồ
    t.layer.save({ op: 'update', id: t.id, level: e.target.value })
      .then(() => { if (!inList) t.layer.open(t.id); })
      .catch((err) => alert(err.message));
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
