'use strict';

// Bộ lọc "Thêm vùng": vẽ vùng trên bản đồ (bấm từng điểm, nối thành đa giác), chỉ hiện tin nằm
// trong vùng. Vùng lưu trong state.zone (URL), app.js lọc tin bằng Filters.inZones.
// Vẽ: bấm lên bản đồ để đặt điểm; bấm lại điểm đầu, bấm đúp, Enter hoặc nút "Xong" để khép vùng;
// Backspace / "Xoá điểm cuối" để bỏ điểm vừa đặt; Esc / "Huỷ" để thôi.
(() => {
  const COLOR = '#1d6fdc';
  const pane = map.createPane('zones');
  pane.style.zIndex = 350; // dưới ghim tin và các lớp điểm ngập / đỗ xe
  pane.style.pointerEvents = 'none'; // chỉ để xem: bấm xuyên qua vùng như bình thường
  const renderer = L.svg({ pane: 'zones' });
  const zoneLayer = L.layerGroup().addTo(map);
  const draftLayer = L.layerGroup().addTo(map);

  const pop = document.getElementById('zonePop');
  const ui = {
    title: pop.querySelector('[data-zone-title]'),
    label: pop.querySelector('#zoneLabel'),
    list: pop.querySelector('[data-zone-list]'),
    draw: pop.querySelector('[data-zone-draw]'),
  };

  const zones = () => Filters.parseZones(state.zone);
  const saveZones = (list) => updateLocal({ zone: Filters.formatZones(list) });

  // ---------- vùng đã vẽ ----------

  function renderZones() {
    zoneLayer.clearLayers();
    const list = zones();
    list.forEach((poly, i) => {
      const shape = L.polygon(poly, {
        renderer, pane: 'zones', interactive: false,
        color: COLOR, weight: 2, opacity: 0.9, dashArray: '7 5', fillColor: COLOR, fillOpacity: 0.07,
      }).addTo(zoneLayer);
      L.marker(shape.getBounds().getCenter(), {
        pane: 'zones', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'zone-label', html: `<span>Vùng ${i + 1}</span>`, iconSize: null }),
      }).addTo(zoneLayer);
    });
    // Nút trên thanh lọc: "Thêm vùng" (chưa có vùng, bấm là vẽ) / "Vùng · 2" (bấm mở danh sách vùng).
    ui.title.textContent = list.length ? 'Vùng' : 'Thêm vùng';
    ui.label.textContent = list.length ? String(list.length) : '';
    ui.list.innerHTML = list.map((poly, i) => `<li>
        <span class="zone-name">${icon('polygon')} Vùng ${i + 1} <small>${poly.length} điểm</small></span>
        <button type="button" data-zone-show="${i}">${icon('pin')} Xem</button>
        <button type="button" class="danger" data-zone-del="${i}">${icon('trash')} Xoá</button>
      </li>`).join('');
    ui.draw.disabled = list.length >= Filters.MAX_ZONES;
    ui.draw.title = ui.draw.disabled ? `Tối đa ${Filters.MAX_ZONES} vùng` : '';
  }
  window.syncZones = renderZones;

  pop.querySelector('summary').addEventListener('click', (e) => {
    if (zones().length) return; // đã có vùng: mở danh sách vùng như các bộ lọc khác
    e.preventDefault();
    startDraw();
  });
  pop.addEventListener('click', (e) => {
    const show = e.target.closest('[data-zone-show]');
    const del = e.target.closest('[data-zone-del]');
    if (e.target.closest('[data-zone-draw]')) startDraw();
    else if (show) {
      pop.open = false;
      showMap();
      map.fitBounds(L.polygon(zones()[Number(show.dataset.zoneShow)]).getBounds(), { padding: [40, 40], maxZoom: 17 });
    } else if (del) {
      const list = zones();
      list.splice(Number(del.dataset.zoneDel), 1);
      saveZones(list);
    }
  });

  // Đang ở chế độ Danh sách thì mở bản đồ để vẽ / xem vùng.
  function showMap() {
    if (document.body.dataset.view === 'list') setView(window.innerWidth < 800 ? 'map' : 'split');
  }

  // ---------- vẽ vùng mới ----------

  let draw = null; // { pts: [[lat, lng]…], cursor: latlng | null }

  const bar = document.createElement('div');
  bar.className = 'zone-bar';
  bar.hidden = true;
  bar.innerHTML = `<span class="zone-bar-text" data-zone-hint></span>
    <span class="zone-bar-acts">
      <button type="button" class="primary" data-zone-done>${icon('check')} Xong</button>
      <button type="button" data-zone-undo>${icon('undo')} Xoá điểm cuối</button>
      <button type="button" data-zone-cancel>${icon('close')} Huỷ</button>
    </span>`;
  map.getContainer().append(bar);
  L.DomEvent.disableClickPropagation(bar);
  const hint = bar.querySelector('[data-zone-hint]');

  function startDraw() {
    if (zones().length >= Filters.MAX_ZONES) {
      mapNotice(`Đã có ${Filters.MAX_ZONES} vùng, hãy xoá bớt vùng cũ trước khi vẽ thêm.`);
      return;
    }
    if (typeof activeLayer !== 'undefined' && activeLayer) activeLayer.setMode(null); // đang đặt điểm ngập / đỗ xe
    pop.open = false;
    showMap();
    map.closePopup();
    draw = { pts: [], cursor: null };
    map.doubleClickZoom.disable(); // bấm đúp để khép vùng
    map.getContainer().classList.add('drawing');
    document.body.classList.add('zone-drawing'); // tạm ẩn bảng điểm ngập / đỗ xe và chú thích cho thoáng
    bar.hidden = false;
    setTimeout(() => map.invalidateSize(), 60);
    redraw();
  }

  function stopDraw() {
    draw = null;
    draftLayer.clearLayers();
    bar.hidden = true;
    document.body.classList.remove('zone-drawing');
    map.doubleClickZoom.enable();
    if (typeof activeLayer === 'undefined' || !activeLayer) map.getContainer().classList.remove('drawing');
  }
  window.cancelZoneDraw = () => { if (draw) stopDraw(); };

  function redraw() {
    draftLayer.clearLayers();
    const { pts, cursor } = draw;
    if (pts.length) {
      const line = cursor ? [...pts, [cursor.lat, cursor.lng]] : pts;
      if (pts.length >= 3) {
        L.polygon(cursor ? line : pts, { renderer, pane: 'zones', interactive: false, stroke: false, fillColor: COLOR, fillOpacity: 0.08 }).addTo(draftLayer);
      }
      L.polyline(line, { renderer, pane: 'zones', interactive: false, color: COLOR, weight: 2.5, dashArray: '7 5' }).addTo(draftLayer);
      pts.forEach((p, i) => {
        // Điểm đầu to hơn khi đã đủ 3 điểm: bấm vào để khép vùng.
        const first = i === 0 && pts.length >= 3;
        L.circleMarker(p, {
          renderer, pane: 'zones', interactive: false,
          radius: first ? 7 : 4.5, color: COLOR, weight: 2, fillColor: first ? COLOR : '#fff', fillOpacity: 1,
        }).addTo(draftLayer);
      });
    }
    const n = pts.length;
    hint.textContent = n === 0
      ? 'Bấm lên bản đồ để đặt điểm đầu tiên của vùng.'
      : n < 3
        ? `Đã đặt ${n} điểm, đặt thêm ít nhất ${3 - n} điểm nữa.`
        : `Đã đặt ${n} điểm. Bấm lại điểm đầu, bấm đúp hoặc Enter để khép vùng.`;
    bar.querySelector('[data-zone-done]').disabled = n < 3;
    bar.querySelector('[data-zone-undo]').disabled = n === 0;
  }

  // Hai điểm gần nhau (px) trên màn hình.
  const near = (a, b, px) => map.latLngToContainerPoint(a).distanceTo(map.latLngToContainerPoint(b)) <= px;

  function finish() {
    if (!draw) return;
    // Bấm đúp sinh thêm 1–2 điểm trùng nhau ở cuối: bỏ đi.
    const pts = draw.pts.filter((p, i, all) => i === 0 || !near(p, all[i - 1], 4));
    if (pts.length < 3) {
      redraw();
      return;
    }
    const list = zones();
    list.push(pts.slice(0, Filters.MAX_ZONE_POINTS));
    stopDraw();
    saveZones(list);
    mapNotice(`Đã thêm Vùng ${list.length}: chỉ hiện tin nằm trong ${list.length > 1 ? 'các vùng đã vẽ' : 'vùng này'}. Bấm nút "Vùng" trên thanh lọc để xem / xoá vùng.`);
  }

  // Bấm trên bản đồ khi đang vẽ (app.js gọi hook trước khi mở popup toạ độ).
  mapClickHooks.push((e) => {
    if (!draw) return false;
    const p = [e.latlng.lat, e.latlng.lng];
    if (draw.pts.length >= 3 && near(draw.pts[0], p, 12)) {
      finish();
      return true;
    }
    if (draw.pts.length >= Filters.MAX_ZONE_POINTS) {
      mapNotice(`Mỗi vùng tối đa ${Filters.MAX_ZONE_POINTS} điểm.`);
      return true;
    }
    draw.pts.push(p);
    redraw();
    return true;
  });
  map.on('dblclick', () => { if (draw) finish(); });
  map.on('mousemove', (e) => {
    if (!draw || !draw.pts.length) return;
    draw.cursor = e.latlng;
    redraw();
  });
  map.on('mouseout', () => {
    if (!draw) return;
    draw.cursor = null;
    redraw();
  });

  bar.addEventListener('click', (e) => {
    if (e.target.closest('[data-zone-done]')) finish();
    else if (e.target.closest('[data-zone-undo]')) { draw.pts.pop(); redraw(); }
    else if (e.target.closest('[data-zone-cancel]')) stopDraw();
  });
  document.addEventListener('keydown', (e) => {
    if (!draw || e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'Escape') stopDraw();
    else if (e.key === 'Enter') finish();
    else if (e.key === 'Backspace') { e.preventDefault(); draw.pts.pop(); redraw(); }
    else return;
    e.preventDefault();
  });

  renderZones();
})();
