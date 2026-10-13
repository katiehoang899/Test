'use strict';

// Bảng "Tuỳ chỉnh bản đồ" (góc trên bên trái):
//   - Lớp bản đồ: chọn lớp nền như bảng "Map Layers" của openstreetmap.org (ô xem trước là ảnh thật
//     của lớp đó tại chỗ đang xem). Chỉ các lớp miễn phí, không cần API key.
//   - Màu: chỉnh màu ảnh nền bằng bộ lọc CSS (chỉ ảnh nền đổi màu; ghim tin, điểm ngập, đỗ xe giữ nguyên màu).
//   - Công trình: bật / tắt từng loại (bệnh viện, trường học…) lấy từ OpenStreetMap qua Overpass,
//     đổi màu từng loại. Ảnh nền là ảnh có sẵn nên không ẩn được biểu tượng in trên đó; nền "Nhạt"
//     gần như không có biểu tượng, hợp để chỉ hiện các loại tự chọn.
// Bọc trong hàm để không đụng tên biến toàn cục của app.js / userlayers.js.
(() => {
  const POI_CATS = [
    { id: 'hospital', label: 'Bệnh viện, phòng khám', icon: 'hospital', color: '#c2255c' },
    { id: 'pharmacy', label: 'Nhà thuốc', icon: 'pill', color: '#0c8599' },
    { id: 'school', label: 'Trường học', icon: 'school', color: '#e8590c' },
    { id: 'market', label: 'Chợ, siêu thị', icon: 'cart', color: '#7048e8' },
    { id: 'police', label: 'Công an', icon: 'shield', color: '#364fc7' },
    { id: 'bank', label: 'Ngân hàng, ATM', icon: 'bank', color: '#9c6b00' },
    { id: 'bus', label: 'Trạm xe buýt', icon: 'bus', color: '#495057' },
    { id: 'park', label: 'Công viên', icon: 'tree', color: '#5c940d' },
  ];
  const CAT = Object.fromEntries(POI_CATS.map((c) => [c.id, c]));

  const TONE0 = { sat: 100, bri: 100, con: 100, warm: 0, hue: 0, dark: false };
  const PRESETS = [
    { id: 'default', label: 'Mặc định', tone: {} },
    { id: 'soft', label: 'Nhạt', tone: { sat: 45, bri: 106, con: 92 } },
    { id: 'gray', label: 'Xám', tone: { sat: 0, bri: 103, con: 102 } },
    { id: 'warm', label: 'Ấm', tone: { sat: 90, warm: 35, con: 98 } },
    { id: 'vivid', label: 'Rực rỡ', tone: { sat: 165, con: 108 } },
    { id: 'dark', label: 'Tối', tone: { dark: true, sat: 60, bri: 95, con: 92 } },
  ].map((p) => ({ ...p, tone: { ...TONE0, ...p.tone } }));
  const SLIDERS = [
    { key: 'sat', label: 'Độ đậm màu', min: 0, max: 200, unit: '%' },
    { key: 'bri', label: 'Độ sáng', min: 50, max: 150, unit: '%' },
    { key: 'con', label: 'Tương phản', min: 50, max: 150, unit: '%' },
    { key: 'warm', label: 'Tông ấm', min: 0, max: 100, unit: '%' },
    { key: 'hue', label: 'Xoay màu', min: 0, max: 359, unit: '°' },
  ];

  const MIN_ZOOM = 15; // nhỏ hơn thì quá nhiều công trình, bản đồ rối và chậm
  const CELL = 0.05; // khớp POI_CELL ở server.js

  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* không bắt buộc */ }
  }

  const savedTone = load('phongtro.maptone', {});
  const tone = { ...TONE0 };
  for (const k of Object.keys(TONE0)) if (typeof savedTone?.[k] === typeof TONE0[k]) tone[k] = savedTone[k];
  const savedPoi = load('phongtro.pois', {});
  const poi = {
    on: new Set((Array.isArray(savedPoi?.on) ? savedPoi.on : []).filter((id) => CAT[id])),
    colors: {},
  };
  for (const c of POI_CATS) poi.colors[c.id] = /^#[0-9a-f]{6}$/i.test(savedPoi?.colors?.[c.id]) ? savedPoi.colors[c.id] : c.color;

  // ---------- màu nền ----------

  function filterOf(t) {
    const f = [];
    if (t.dark) f.push('invert(1)', 'hue-rotate(180deg)'); // đảo sáng / tối, giữ màu (nước vẫn xanh)
    if (t.hue) f.push(`hue-rotate(${t.hue}deg)`);
    if (t.warm) f.push(`sepia(${t.warm}%)`);
    if (t.sat !== 100) f.push(`saturate(${t.sat}%)`);
    if (t.bri !== 100) f.push(`brightness(${t.bri}%)`);
    if (t.con !== 100) f.push(`contrast(${t.con}%)`);
    return f.join(' ') || 'none';
  }
  const sameTone = (a, b) => Object.keys(TONE0).every((k) => a[k] === b[k]);

  function applyTone() {
    map.getPane('tilePane').style.filter = filterOf(tone);
    map.getContainer().classList.toggle('ms-dark', tone.dark);
    store('phongtro.maptone', tone);
    if (!ui) return;
    const preset = PRESETS.find((p) => sameTone(p.tone, tone));
    ui.presets.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.preset === preset?.id)));
    for (const s of SLIDERS) {
      ui.sliders[s.key].value = tone[s.key];
      ui.values[s.key].textContent = tone[s.key] + s.unit;
    }
    ui.dark.checked = tone.dark;
    ui.reset.disabled = sameTone(tone, TONE0);
  }

  // ---------- bảng điều khiển ----------

  // Ô xem trước của từng kiểu màu: mảnh "bản đồ" giả (đất, nước, công viên, đường) qua cùng bộ lọc.
  const presetHtml = (p) => `<button type="button" role="radio" data-preset="${p.id}" title="Kiểu màu: ${esc(p.label)}">
      <i class="ms-swatch" style="filter:${filterOf(p.tone)}"></i><span>${esc(p.label)}</span></button>`;
  const sliderHtml = (s) => `<label class="ms-slider"><span>${esc(s.label)}</span><output data-val="${s.key}"></output>
      <input type="range" data-tone="${s.key}" min="${s.min}" max="${s.max}" step="1"></label>`;
  const poiRowHtml = (c) => `<li>
      <label class="ms-check"><input type="checkbox" data-poi="${c.id}"> <i class="poi-ic" data-poi-ic="${c.id}">${icon(c.icon)}</i> <span class="tx">${esc(c.label)}</span></label>
      <input type="color" data-poi-color="${c.id}" title="Đổi màu ${esc(c.label.toLowerCase())}" aria-label="Màu ${esc(c.label.toLowerCase())}">
    </li>`;

  const layerHtml = (d) => `<button type="button" role="radio" class="ms-layer" data-base="${d.id}"
      title="${esc(d.name)}: ${esc(d.desc)}">
      <i class="ms-thumb"></i><span class="ms-layer-name">${esc(d.name)}</span>
    </button>`;

  let ui = null;
  const Control = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const div = L.DomUtil.create('div', 'ms-ctl');
      div.innerHTML = `
        <button type="button" class="ms-btn" data-ms-toggle title="Tuỳ chỉnh bản đồ: nền, màu sắc, công trình (bệnh viện, trường học…)"
          aria-label="Tuỳ chỉnh bản đồ" aria-expanded="false">${icon('palette')}<b class="ms-badge" data-ms-badge hidden></b></button>
        <div class="ms-panel" data-ms-panel hidden>
          <div class="ms-head">
            <b>Tuỳ chỉnh bản đồ</b>
            <button type="button" class="ms-close" data-ms-close aria-label="Đóng">${icon('close')}</button>
          </div>
          <div class="ms-tabs" role="tablist">
            <button type="button" role="tab" data-tab="layers" aria-selected="true">${icon('layers')} <span class="tx">Lớp</span></button>
            <button type="button" role="tab" data-tab="tone" aria-selected="false">${icon('palette')} <span class="tx">Màu</span></button>
            <button type="button" role="tab" data-tab="poi" aria-selected="false">${icon('hospital')} <span class="tx">Công trình</span> <b data-ms-count hidden></b></button>
          </div>
          <section class="ms-pane" data-pane="layers">
            <div class="ms-layers" role="radiogroup" aria-label="Lớp bản đồ">${BASEMAP_DEFS.map(layerHtml).join('')}</div>
            <div class="ms-layer-info" data-layer-info></div>
          </section>
          <section class="ms-pane" data-pane="tone" hidden>
            <div class="ms-label">Kiểu màu</div>
            <div class="ms-presets" role="radiogroup" aria-label="Kiểu màu nền">${PRESETS.map(presetHtml).join('')}</div>
            <div class="ms-sliders">${SLIDERS.map(sliderHtml).join('')}</div>
            <label class="ms-check"><input type="checkbox" data-dark> <span class="tx">Đảo màu (nền tối)</span></label>
            <button type="button" class="ms-reset" data-ms-reset>${icon('undo')} Khôi phục màu mặc định</button>
          </section>
          <section class="ms-pane" data-pane="poi" hidden>
            <div class="ms-poi-tools">
              <button type="button" data-poi-all>Hiện tất cả</button>
              <button type="button" data-poi-none>Ẩn tất cả</button>
            </div>
            <ul class="ms-poi">${POI_CATS.map(poiRowHtml).join('')}</ul>
            <div class="ms-status" data-ms-status role="status"></div>
            <p class="ms-note">Dữ liệu từ OpenStreetMap. Biểu tượng in sẵn trên ảnh nền không ẩn được: chọn lớp <b>CARTO Nhạt</b> để chỉ còn các loại bạn bật.</p>
          </section>
        </div>`;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    },
  });
  const ctl = new Control();
  map.addControl(ctl);
  const root = ctl.getContainer();
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  ui = {
    toggle: $('[data-ms-toggle]'),
    panel: $('[data-ms-panel]'),
    badge: $('[data-ms-badge]'),
    count: $('[data-ms-count]'),
    status: $('[data-ms-status]'),
    tabs: $$('[data-tab]'),
    panes: $$('[data-pane]'),
    layers: $$('[data-base]'),
    layerInfo: $('[data-layer-info]'),
    presets: $$('[data-preset]'),
    sliders: Object.fromEntries($$('[data-tone]').map((el) => [el.dataset.tone, el])),
    values: Object.fromEntries($$('[data-val]').map((el) => [el.dataset.val, el])),
    dark: $('[data-dark]'),
    reset: $('[data-ms-reset]'),
  };

  function setOpen(open) {
    ui.panel.hidden = !open;
    ui.toggle.setAttribute('aria-expanded', String(open));
    root.classList.toggle('open', open);
    root.parentElement.style.zIndex = open ? '1001' : ''; // nổi trên bảng điểm ngập / đỗ xe góc phải (màn hình hẹp)
    if (open) { fitPanel(); updateThumbs(); }
  }
  // Bảng không cao quá phần bản đồ còn trống bên dưới nút.
  function fitPanel() {
    const top = ui.panel.getBoundingClientRect().top - map.getContainer().getBoundingClientRect().top;
    ui.panel.style.maxHeight = Math.max(200, map.getSize().y - top - 12) + 'px';
  }
  ui.toggle.addEventListener('click', () => setOpen(ui.panel.hidden));
  $('[data-ms-close]').addEventListener('click', () => setOpen(false));
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ui.panel.hidden) { setOpen(false); ui.toggle.focus(); }
  });
  map.on('click', () => setOpen(false));
  map.on('resize', () => { if (!ui.panel.hidden) fitPanel(); });

  function setTab(id) {
    ui.tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === id)));
    ui.panes.forEach((p) => { p.hidden = p.dataset.pane !== id; });
    try { localStorage.setItem('phongtro.mapstyle.tab', id); } catch { /* không bắt buộc */ }
  }
  ui.tabs.forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
  try {
    const tab = localStorage.getItem('phongtro.mapstyle.tab');
    if (tab === 'tone' || tab === 'poi') setTab(tab);
  } catch { /* bỏ qua */ }

  // ---------- lớp bản đồ ----------

  function syncLayers() {
    ui.layers.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.base === basemap)));
    const d = basemapDef(basemap);
    ui.layerInfo.innerHTML = `Đang dùng <b>${esc(d.name)}</b>: ${esc(d.desc)}.`;
  }

  // Ô xem trước: ảnh ô bản đồ của từng lớp ở đúng chỗ đang xem, căn giữa vào tâm bản đồ.
  function updateThumbs() {
    if (ui.panel.hidden || $('[data-pane="layers"]').hidden) return;
    const c = map.getCenter();
    const z = Math.max(map.getZoom(), 12); // xa quá thì ô xem trước toàn biển / rừng, không thấy khác nhau
    for (const b of ui.layers) {
      const img = b.querySelector('.ms-thumb');
      const tiles = basemapTiles(b.dataset.base, c.lat, c.lng, z);
      img.style.backgroundImage = tiles.map((t) => `url("${t.url}")`).join(', ');
      img.style.backgroundPosition = tiles.map((t) => `calc(50% + ${t.ox}px) calc(50% + ${t.oy}px)`).join(', ');
    }
  }
  map.on('moveend', updateThumbs);
  ui.tabs.forEach((t) => t.addEventListener('click', updateThumbs));

  ui.layers.forEach((b) => b.addEventListener('click', () => { setBasemap(b.dataset.base); syncLayers(); }));
  map.on('basemapchange', syncLayers);
  syncLayers();

  // Màu nền
  ui.presets.forEach((b) => b.addEventListener('click', () => {
    Object.assign(tone, PRESETS.find((p) => p.id === b.dataset.preset).tone);
    applyTone();
  }));
  for (const el of Object.values(ui.sliders)) {
    el.addEventListener('input', () => { tone[el.dataset.tone] = Number(el.value); applyTone(); });
  }
  ui.dark.addEventListener('change', () => { tone.dark = ui.dark.checked; applyTone(); });
  ui.reset.addEventListener('click', () => { Object.assign(tone, TONE0); applyTone(); });
  applyTone();

  // ---------- công trình ----------

  map.createPane('pois').style.zIndex = 455; // trên điểm ngập / đoạn đỗ xe (canvas 450), dưới biển P (460) và ghim tin (600)
  const poiLayer = L.layerGroup().addTo(map);
  const markers = new Map(); // id → marker đang hiện
  const cells = new Map(); // "i,j" → { pois } | { loading: true } | { error, at }

  function savePoi() {
    store('phongtro.pois', { on: [...poi.on], colors: poi.colors });
  }

  function syncPoiUi() {
    $$('[data-poi]').forEach((el) => { el.checked = poi.on.has(el.dataset.poi); });
    $$('[data-poi-color]').forEach((el) => { el.value = poi.colors[el.dataset.poiColor]; });
    $$('[data-poi-ic]').forEach((el) => { el.style.setProperty('--c', poi.colors[el.dataset.poiIc]); });
    const n = poi.on.size;
    ui.count.hidden = !n;
    ui.count.textContent = String(n);
    ui.badge.hidden = !n;
    ui.badge.textContent = String(n);
  }

  function setStatus(text, retry) {
    ui.status.textContent = text;
    if (retry) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Thử lại';
      b.addEventListener('click', () => {
        for (const [k, c] of cells) if (c.error) cells.delete(k);
        refresh();
      });
      ui.status.append(' ', b);
    }
  }

  function cellsIn(bounds) {
    const keys = [];
    const i0 = Math.floor(bounds.getSouth() / CELL);
    const i1 = Math.floor(bounds.getNorth() / CELL);
    const j0 = Math.floor(bounds.getWest() / CELL);
    const j1 = Math.floor(bounds.getEast() / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) keys.push(`${i},${j}`);
    return keys;
  }

  function fetchCell(key) {
    const c = cells.get(key);
    if (c && (c.pois || c.loading || Date.now() - c.at < 30000)) return; // lỗi: chờ 30 giây mới hỏi lại
    cells.set(key, { loading: true });
    api(`/api/pois?cell=${key}`)
      .then((d) => cells.set(key, { pois: Array.isArray(d.pois) ? d.pois : [] }))
      .catch((err) => cells.set(key, { error: err.message, at: Date.now() }))
      .finally(refresh);
  }

  function poiMarker(p) {
    const cat = CAT[p.cat];
    const m = L.marker([p.lat, p.lng], {
      pane: 'pois',
      keyboard: false,
      icon: L.divIcon({
        className: 'poi-mk',
        html: `<i class="poi-ic" style="--c:${poi.colors[p.cat]}">${icon(cat.icon)}</i>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -11],
      }),
    });
    const title = p.name || cat.label;
    m.bindTooltip(`<b>${esc(title)}</b>${p.name ? `<br>${esc(cat.label)}` : ''}`,
      { direction: 'top', offset: [0, -10], className: 'ul-tip' });
    m.bindPopup(`<div class="poi-pop">
        <div class="up-title"><i class="poi-ic" style="--c:${poi.colors[p.cat]}">${icon(cat.icon)}</i> ${esc(title)}</div>
        ${p.name ? `<div class="poi-cat">${esc(cat.label)}</div>` : ''}
        <a href="${esc(Filters.googleMapsUrl(p.lat, p.lng))}" target="_blank" rel="noopener">${icon('map')} Xem trên Google Maps</a>
      </div>`, { minWidth: 200 });
    return m;
  }

  function clearMarkers() {
    poiLayer.clearLayers();
    markers.clear();
  }

  function refresh() {
    if (!poi.on.size) {
      clearMarkers();
      return setStatus('Bật một loại công trình để hiện trên bản đồ.');
    }
    const z = map.getZoom();
    if (z < MIN_ZOOM) {
      clearMarkers();
      return setStatus(`Phóng to bản đồ thêm để hiện công trình (đang ở mức ${z}, cần ${MIN_ZOOM}).`);
    }
    const bounds = map.getBounds().pad(0.15);
    const keys = cellsIn(bounds);
    keys.forEach(fetchCell);

    const want = new Map();
    let loading = 0;
    let error = null;
    for (const key of keys) {
      const c = cells.get(key);
      if (c?.loading) loading++;
      if (c?.error) error = c.error;
      for (const p of c?.pois || []) {
        if (poi.on.has(p.cat) && bounds.contains([p.lat, p.lng])) want.set(p.id, p);
      }
    }
    for (const [id, m] of markers) {
      if (!want.has(id)) { poiLayer.removeLayer(m); markers.delete(id); }
    }
    for (const [id, p] of want) {
      if (!markers.has(id)) { const m = poiMarker(p); markers.set(id, m); poiLayer.addLayer(m); }
    }
    if (loading) setStatus(`Đang tải công trình… (${want.size} đã hiện)`);
    else if (error) setStatus(error, true);
    else setStatus(want.size ? `${want.size} công trình trong khung nhìn.` : 'Không có công trình loại đã chọn trong khung nhìn.');
  }

  $$('[data-poi]').forEach((el) => el.addEventListener('change', () => {
    if (el.checked) poi.on.add(el.dataset.poi);
    else poi.on.delete(el.dataset.poi);
    savePoi();
    syncPoiUi();
    refresh();
  }));
  $$('[data-poi-color]').forEach((el) => el.addEventListener('input', () => {
    poi.colors[el.dataset.poiColor] = el.value;
    savePoi();
    syncPoiUi();
    clearMarkers(); // vẽ lại với màu mới
    refresh();
  }));
  $('[data-poi-all]').addEventListener('click', () => {
    POI_CATS.forEach((c) => poi.on.add(c.id));
    savePoi(); syncPoiUi(); refresh();
  });
  $('[data-poi-none]').addEventListener('click', () => {
    poi.on.clear();
    savePoi(); syncPoiUi(); refresh();
  });
  map.on('moveend', refresh);
  syncPoiUi();
  refresh();
})();
