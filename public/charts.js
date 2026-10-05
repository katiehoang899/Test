'use strict';

// Biểu đồ nhỏ cho trang báo cáo, không phụ thuộc thư viện (app chạy offline).
// Theo quy tắc dataviz: một chuỗi dữ liệu (tiêu đề gọi tên, không cần chú thích), màu series-1,
// đường 2px, vùng nền 10%, thanh <= 24px bo 4px ở đầu dữ liệu, lưới mảnh, tooltip khi hover/focus,
// và luôn có bảng số liệu để không phụ thuộc vào màu hay tooltip.
(function () {
  const SVG = 'http://www.w3.org/2000/svg';
  const tooltip = () => document.getElementById('chartTooltip');

  function el(tag, attrs = {}, text) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  }

  function svg(tag, attrs = {}) {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  }

  function fmtNum(n) {
    if (!Number.isFinite(n)) return '—';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return Math.round(n).toLocaleString(window.I18N ? I18N.locale() : undefined);
  }

  /** Bước chia trục "đẹp": 1, 2, 5 × 10^k. */
  function niceMax(max, ticks = 4) {
    if (!(max > 0)) return { max: 1, step: 1 };
    const raw = max / ticks;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    return { max: Math.ceil(max / step) * step, step };
  }

  function showTip(x, y, value, label) {
    const tip = tooltip();
    if (!tip) return;
    tip.replaceChildren(el('b', {}, value), el('span', {}, label));
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 12));
    const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hideTip() {
    const tip = tooltip();
    if (tip) tip.hidden = true;
  }

  function card(container, { title, subtitle }) {
    const c = el('figure', { class: 'chart-card' });
    c.appendChild(el('figcaption', {}, ''));
    c.firstChild.append(el('h3', {}, title), el('p', { class: 'small muted' }, subtitle || ''));
    container.appendChild(c);
    return c;
  }

  function table(c, label, headers, rows) {
    const d = el('details', { class: 'chart-table' });
    d.appendChild(el('summary', { class: 'small' }, label));
    const tb = el('table', { class: 'small' });
    const tr = el('tr');
    headers.forEach((h) => tr.appendChild(el('th', {}, h)));
    tb.appendChild(el('thead')).appendChild(tr);
    const body = tb.appendChild(el('tbody'));
    rows.forEach((r) => {
      const row = body.appendChild(el('tr'));
      r.forEach((v) => row.appendChild(el('td', {}, v)));
    });
    d.appendChild(tb);
    c.appendChild(d);
  }

  function empty(c, text) {
    c.appendChild(el('p', { class: 'chart-empty muted small' }, text));
  }

  /**
   * Biểu đồ đường theo thời gian.
   * opts: { title, subtitle, points: [{ x, y }], xLabel(x), yLabel(y), tableLabel, headers, emptyText }
   */
  function line(container, opts) {
    const c = card(container, opts);
    const pts = opts.points || [];
    if (pts.length < 2 || !pts.some((p) => p.y > 0)) return empty(c, opts.emptyText);
    // Đo độ rộng sau khi mọi thẻ trong lưới đã được thêm (lưới auto-fit đổi cột theo số thẻ).
    requestAnimationFrame(() => drawLine(c, opts, pts));
  }

  function drawLine(c, opts, pts) {
    const W = Math.max(280, c.clientWidth - 32);
    const H = 180;
    const m = { l: 44, r: 14, t: 12, b: 26 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const x0 = pts[0].x;
    const x1 = pts[pts.length - 1].x;
    const { max, step } = niceMax(Math.max(...pts.map((p) => p.y)));
    const sx = (x) => m.l + ((x - x0) / Math.max(1, x1 - x0)) * iw;
    const sy = (y) => m.t + ih - (y / max) * ih;

    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, class: 'chart-svg', role: 'img', tabindex: '0', 'aria-label': opts.title });
    // lưới & trục Y
    for (let v = 0; v <= max + 1e-9; v += step) {
      root.appendChild(svg('line', { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), class: 'grid' }));
      const tx = svg('text', { x: m.l - 6, y: sy(v) + 4, 'text-anchor': 'end', class: 'tick' });
      tx.textContent = fmtNum(v);
      root.appendChild(tx);
    }
    // nhãn trục X: khoảng 5 mốc
    const nTicks = Math.min(5, pts.length);
    for (let i = 0; i < nTicks; i++) {
      const p = pts[Math.round((i / Math.max(1, nTicks - 1)) * (pts.length - 1))];
      const tx = svg('text', { x: sx(p.x), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === nTicks - 1 ? 'end' : 'middle', class: 'tick' });
      tx.textContent = opts.xLabel(p.x);
      root.appendChild(tx);
    }
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
    root.appendChild(svg('path', { d: `${d}L${sx(x1)},${sy(0)}L${sx(x0)},${sy(0)}Z`, class: 'area' }));
    root.appendChild(svg('path', { d, class: 'line' }));
    const last = pts[pts.length - 1];
    root.appendChild(svg('circle', { cx: sx(last.x), cy: sy(last.y), r: 4, class: 'dot' }));

    // crosshair + tooltip
    const cross = svg('line', { y1: m.t, y2: m.t + ih, class: 'crosshair', visibility: 'hidden' });
    const hover = svg('circle', { r: 4, class: 'dot', visibility: 'hidden' });
    root.append(cross, hover);
    let idx = pts.length - 1;
    const show = (i, clientX, clientY) => {
      idx = Math.max(0, Math.min(pts.length - 1, i));
      const p = pts[idx];
      cross.setAttribute('x1', sx(p.x));
      cross.setAttribute('x2', sx(p.x));
      hover.setAttribute('cx', sx(p.x));
      hover.setAttribute('cy', sy(p.y));
      cross.setAttribute('visibility', 'visible');
      hover.setAttribute('visibility', 'visible');
      const rect = root.getBoundingClientRect();
      const scale = rect.width / W;
      showTip(clientX ?? rect.left + sx(p.x) * scale, clientY ?? rect.top + sy(p.y) * scale, opts.yLabel(p.y), opts.xLabel(p.x));
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      hover.setAttribute('visibility', 'hidden');
      hideTip();
    };
    root.addEventListener('pointermove', (e) => {
      const rect = root.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * W;
      let best = 0;
      pts.forEach((p, i) => { if (Math.abs(sx(p.x) - x) < Math.abs(sx(pts[best].x) - x)) best = i; });
      show(best, e.clientX, e.clientY);
    });
    root.addEventListener('pointerleave', hide);
    root.addEventListener('blur', hide);
    root.addEventListener('focus', () => show(idx));
    root.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        show(idx + (e.key === 'ArrowRight' ? 1 : -1));
      }
    });
    c.appendChild(root);
    table(c, opts.tableLabel, opts.headers, pts.map((p) => [opts.xLabel(p.x), opts.yLabel(p.y)]));
  }

  /**
   * Biểu đồ thanh ngang.
   * opts: { title, subtitle, rows: [{ label, full, value }], valueLabel(v), tableLabel, headers, emptyText }
   */
  function hbar(container, opts) {
    const c = card(container, opts);
    const all = opts.rows || [];
    // keepZero: các dải theo thứ tự (như độ sâu trang) phải giữ cả dải bằng 0, không thì đọc sai.
    const rows = opts.keepZero ? all : all.filter((r) => r.value > 0);
    if (!all.some((r) => r.value > 0)) return empty(c, opts.emptyText);
    const max = Math.max(...rows.map((r) => r.value));
    const list = el('div', { class: 'hbar', role: 'list' });
    rows.forEach((r) => {
      const row = el('div', { class: 'hbar-row', role: 'listitem', tabindex: '0', 'aria-label': `${r.full || r.label}: ${opts.valueLabel(r.value)}` });
      const name = el('span', { class: 'hbar-label' }, r.label);
      name.title = r.full || r.label;
      const track = el('span', { class: 'hbar-track' });
      const bar = el('span', { class: 'hbar-bar' });
      bar.style.width = r.value > 0 ? Math.max(0.5, (r.value / max) * 100) + '%' : '0';
      if (!r.value) bar.style.minWidth = '0';
      track.appendChild(bar);
      const val = el('span', { class: 'hbar-value' }, opts.valueLabel(r.value));
      row.append(name, track, val);
      const tip = (e) => {
        const rect = bar.getBoundingClientRect();
        showTip(e && e.clientX != null ? e.clientX : rect.right, e && e.clientY != null ? e.clientY : rect.top, opts.valueLabel(r.value), r.full || r.label);
      };
      row.addEventListener('pointermove', tip);
      row.addEventListener('focus', () => tip());
      row.addEventListener('pointerleave', hideTip);
      row.addEventListener('blur', hideTip);
      list.appendChild(row);
    });
    c.appendChild(list);
    table(c, opts.tableLabel, opts.headers, rows.map((r) => [r.full || r.label, opts.valueLabel(r.value)]));
  }

  window.Charts = { line, hbar, fmtNum };
})();
