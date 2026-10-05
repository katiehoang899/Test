'use strict';

// Ghi tương tác bên trong trang đang được test: di chuột, click, cuộn, focus ô nhập liệu,
// kích thước trang và chuyển trang (kể cả SPA đổi URL bằng pushState).
// Dùng chung cho:
//  - bản web: track.js gắn vào iframe (trang đi qua proxy, cùng origin)
//  - app desktop: electron/guest-preload.js gắn vào <webview> (trình duyệt thật, không proxy)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EtRecorder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MOVE_THROTTLE_MS = 50;
  const SCROLL_THROTTLE_MS = 100;
  const URL_POLL_MS = 400;

  /** Giới hạn tần suất gọi, luôn gọi thêm một lần cuối để không mất vị trí kết thúc. */
  function throttle(fn, ms) {
    let last = 0;
    let timer = null;
    let lastArgs = null;
    return (...args) => {
      const t = Date.now();
      lastArgs = args;
      if (t - last >= ms) {
        last = t;
        fn(...args);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          fn(...lastArgs);
        }, ms - (t - last));
      }
    };
  }

  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 5) {
      let part = el.tagName.toLowerCase();
      if (el.id) {
        parts.unshift(part + '#' + (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id));
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
    const link = el.closest && el.closest('a[href]');
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      cls: cls || undefined,
      text: text.slice(0, 120) || undefined,
      href: link ? link.href : undefined,
      selector: cssPath(el),
    };
  }

  function docSize(doc) {
    const de = doc.documentElement;
    const body = doc.body || de;
    return {
      dw: Math.max(de.scrollWidth, body.scrollWidth),
      dh: Math.max(de.scrollHeight, body.scrollHeight),
    };
  }

  function defaultPageUrl(win) {
    const u = new URL(win.location.href);
    u.hash = '';
    return u.toString();
  }

  /**
   * Gắn bộ ghi vào một cửa sổ trang.
   * @param {Window} win
   * @param {(event: object) => void} emit  nhận từng sự kiện (chưa có trường t)
   * @param {{ getPageUrl?: () => string }} [opts]
   */
  function installRecorder(win, emit, opts = {}) {
    const doc = win.document;
    const getPageUrl = opts.getPageUrl || (() => defaultPageUrl(win));
    let page = getPageUrl();
    const listeners = [];
    const timers = [];

    const on = (target, type, fn, options) => {
      target.addEventListener(type, fn, options);
      listeners.push(() => target.removeEventListener(type, fn, options));
    };
    const view = () => ({
      vw: win.innerWidth,
      vh: win.innerHeight,
      sx: win.scrollX,
      sy: win.scrollY,
      ...docSize(doc),
    });
    const send = (ev) => emit({ page, ...ev });
    const pageview = () => {
      send({ type: 'pageview', title: doc.title, ...view() });
      // Trang thường cao thêm sau khi ảnh/JS tải xong → ghi lại kích thước.
      timers.push(setTimeout(() => send({ type: 'resize', ...view() }), 1500));
    };

    pageview();

    on(doc, 'mousemove', throttle((e) => {
      send({ type: 'move', x: e.pageX, y: e.pageY, vx: e.clientX, vy: e.clientY });
    }, MOVE_THROTTLE_MS), { capture: true, passive: true });

    let lastClickAt = 0;
    const sendClick = (e) => {
      const target = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
      if (target) send({ type: 'click', x: e.pageX, y: e.pageY, vx: e.clientX, vy: e.clientY, el: describe(target) });
    };
    on(win, 'click', (e) => {
      lastClickAt = Date.now();
      sendClick(e);
    }, true);

    // Ứng dụng vẽ bằng canvas (ví dụ prototype Figma) thường chặn sự kiện click:
    // nhấn + nhả chuột tại chỗ mà không có click theo sau thì vẫn ghi là một click.
    let down = null;
    on(win, 'pointerdown', (e) => {
      if (e.isPrimary && e.button === 0) down = { x: e.clientX, y: e.clientY, at: Date.now() };
    }, true);
    on(win, 'pointerup', (e) => {
      const d = down;
      down = null;
      if (!d || !e.isPrimary || Date.now() - d.at > 800 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
      const at = Date.now();
      timers.push(setTimeout(() => {
        if (lastClickAt < d.at && lastClickAt < at) sendClick(e);
      }, 80));
    }, true);

    on(doc, 'focusin', (e) => {
      const el = e.target;
      if (el && /^(input|textarea|select)$/i.test(el.tagName)) send({ type: 'focus', el: describe(el) });
    }, true);

    on(win, 'scroll', throttle(() => send({ type: 'scroll', ...view() }), SCROLL_THROTTLE_MS), { passive: true });
    on(win, 'resize', throttle(() => send({ type: 'resize', ...view() }), 300));
    on(win, 'load', () => send({ type: 'resize', ...view() }));

    // SPA đổi URL bằng history.pushState mà không tải lại trang → ghi thành lượt xem mới.
    const poll = setInterval(() => {
      let url;
      try {
        // win có thể là WindowProxy của iframe: sau khi chuyển trang nó trỏ sang tài liệu mới,
        // tài liệu mới đã có bộ ghi riêng → bộ ghi này dừng để không ghi trùng lượt xem.
        if (win.document !== doc) return clearInterval(poll);
        url = getPageUrl();
      } catch {
        return;
      }
      if (url !== page) {
        page = url;
        pageview();
      }
    }, URL_POLL_MS);

    return {
      get page() {
        return page;
      },
      dispose() {
        clearInterval(poll);
        timers.forEach(clearTimeout);
        listeners.forEach((off) => off());
      },
    };
  }

  return { installRecorder, describe, cssPath, throttle };
});
