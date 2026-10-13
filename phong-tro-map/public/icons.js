'use strict';

// Bộ icon nét (outline) dùng cho mọi nút / link: lưới 24×24, nét 1.8, đầu nét và góc bo tròn,
// màu theo màu chữ (currentColor). Dùng: icon('heart') trong JS, hoặc <span data-icon="heart">
// trong HTML (được vẽ khi trang tải).
(function (root) {
  const P = {
    // xem / bố cục
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="2.6"/>',
    split: '<rect x="3" y="4" width="18" height="16" rx="4"/><path d="M11 4v16"/>',
    map: '<path d="M9 4.5 4.3 6.4A2 2 0 0 0 3 8.3v10.2a1.5 1.5 0 0 0 2 1.4l4-1.6 6 2 4.7-1.9a2 2 0 0 0 1.3-1.9V6.3a1.5 1.5 0 0 0-2-1.4L15 6.5z"/><path d="M9 4.5v14M15 6.5v14"/>',
    layers: '<path d="m12 4 8.5 4.3L12 12.6 3.5 8.3z"/><path d="m3.5 12.2 8.5 4.3 8.5-4.3M3.5 16 12 20.3l8.5-4.3"/>',
    // hành động
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/>',
    heart: '<path d="M12 19.5s-7.6-4.5-8.7-9.7C2.5 6.2 4.9 4 7.7 4c1.8 0 3.3 1 4.3 2.5C13 5 14.5 4 16.3 4c2.8 0 5.2 2.2 4.4 5.8-1.1 5.2-8.7 9.7-8.7 9.7z"/>',
    check: '<path d="m5 12.5 4.3 4.3L19 7.2"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.2 12.3 2.6 2.6 5-5.1"/>',
    undo: '<path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5H15a5 5 0 0 1 0 10h-3"/>',
    copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="3"/><path d="M15.5 8.5V7a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v5.5a3 3 0 0 0 3 3h1.5"/>',
    trash: '<path d="M4 7h16M9.5 11v5.5M14.5 11v5.5"/><path d="M6 7l.9 11.1A2 2 0 0 0 8.9 20h6.2a2 2 0 0 0 2-1.9L18 7"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M7 7l10 10M17 7 7 17"/>',
    arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    external: '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v3a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h3"/>',
    download: '<path d="M12 4v11M7 10.5l5 5 5-5"/><path d="M5 19.5h14"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="3"/>',
    // liên hệ / bản đồ
    phone: '<path d="M8.4 4.5 6 4.6C4.8 4.7 3.9 5.8 4 7c.6 6.8 6.2 12.4 13 13 1.2.1 2.3-.8 2.4-2l.1-2.4a1.5 1.5 0 0 0-1-1.5l-2.8-1a1.5 1.5 0 0 0-1.6.4l-1.1 1.2a10.6 10.6 0 0 1-4.7-4.7l1.2-1.1a1.5 1.5 0 0 0 .4-1.6l-1-2.8a1.5 1.5 0 0 0-1.5-1z"/>',
    pin: '<path d="M12 20.5s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z"/><circle cx="12" cy="9.5" r="2.4"/>',
    pinPlus: '<path d="M12 20.5s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z"/><path d="M12 7v5M9.5 9.5h5"/>',
    route: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8"/>',
    person: '<circle cx="12" cy="7.5" r="3.5"/><path d="M5.5 19.5c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/>',
    drop: '<path d="M12 3.8s-6 6.2-6 10.4a6 6 0 0 0 12 0c0-4.2-6-10.4-6-10.4z"/><path d="M9.3 14.6a2.8 2.8 0 0 0 2.7 2.6"/>',
    car: '<path d="M5 12 6.5 7.6A2.3 2.3 0 0 1 8.7 6h6.6a2.3 2.3 0 0 1 2.2 1.6L19 12"/><rect x="3.5" y="12" width="17" height="5.5" rx="2.2"/><path d="M6.5 17.5v1.8M17.5 17.5v1.8"/><path d="M7.5 14.8h.01M16.5 14.8h.01" stroke-width="2.6"/>',
    // Tuỳ chỉnh bản đồ + các loại công trình (bệnh viện, trường học…)
    palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.1 0 1.7-.7 1.7-1.6 0-1.2-1-1.5-1-2.5 0-.9.7-1.4 1.6-1.4h2.2a4 4 0 0 0 4-4c0-4.2-3.8-7.5-8.5-7.5z"/><path d="M7.6 12h.01M9.3 7.9h.01M14.2 7.4h.01M17 10.8h.01" stroke-width="2.6"/>',
    hospital: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/>',
    pill: '<path d="M10.6 5.6a4.2 4.2 0 0 1 5.9 5.9l-5 5a4.2 4.2 0 0 1-5.9-5.9z"/><path d="m8.1 8.1 5.9 5.9"/>',
    school: '<path d="M2.8 9.5 12 5l9.2 4.5L12 14z"/><path d="M6.8 11.6v4.1c0 1.3 2.3 2.6 5.2 2.6s5.2-1.3 5.2-2.6v-4.1M21.2 9.5v5"/>',
    cart: '<path d="M3.5 4.5h2.2l2 10.3h9.8l2-7.3H6.6"/><path d="M9.6 19.2h.01M16.4 19.2h.01" stroke-width="3"/>',
    shield: '<path d="M12 3.6 5 6.3v5.3c0 4.3 2.9 7.5 7 8.9 4.1-1.4 7-4.6 7-8.9V6.3z"/><path d="m9 12 2.1 2.1L15.2 10"/>',
    bank: '<path d="M3.8 9.4 12 5l8.2 4.4z"/><path d="M6.3 11.2v5.6M10.1 11.2v5.6M13.9 11.2v5.6M17.7 11.2v5.6M4 19.3h16"/>',
    bus: '<rect x="5" y="3.8" width="14" height="13.6" rx="3"/><path d="M5 11h14M8.3 17.4v2.3M15.7 17.4v2.3"/><path d="M8.6 14.2h.01M15.4 14.2h.01" stroke-width="2.6"/>',
    tree: '<path d="M12 3.8c-2.9 0-5 2.3-5 4.9 0 .5.1 1 .2 1.4a3.7 3.7 0 0 0 1.5 7h6.6a3.7 3.7 0 0 0 1.5-7c.1-.4.2-.9.2-1.4 0-2.6-2.1-4.9-5-4.9z"/><path d="M12 10.5v9.7"/>',
  };

  function icon(name, cls = '') {
    const body = P[name];
    if (!body) return '';
    return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  // Vẽ icon cho các phần tử <… data-icon="tên"> có sẵn trong HTML.
  function hydrate(scope = document) {
    scope.querySelectorAll('[data-icon]').forEach((el) => {
      if (el.querySelector(':scope > svg.ic')) return;
      el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, el.dataset.iconClass || ''));
    });
  }

  root.icon = icon;
  root.ICONS = P;
  if (typeof document !== 'undefined') hydrate();
})(typeof self !== 'undefined' ? self : this);
