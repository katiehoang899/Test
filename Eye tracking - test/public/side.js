'use strict';

// Thu gọn / mở rộng các thẻ ở cột trái (trang Báo cáo, Transcript). Thẻ có data-collapse="<khoá>"
// và nút .side-toggle trong tiêu đề; trạng thái được nhớ trên máy này.
(function () {
  const STORE = 'heatmap.side.collapsed';
  const load = () => {
    try { return new Set(JSON.parse(localStorage.getItem(STORE) || '[]')); } catch { return new Set(); }
  };
  const save = (set) => {
    try { localStorage.setItem(STORE, JSON.stringify([...set])); } catch { /* bỏ qua */ }
  };

  function apply(card, collapsed) {
    card.classList.toggle('collapsed', collapsed);
    const btn = card.querySelector('.side-toggle');
    if (btn) btn.setAttribute('aria-expanded', String(!collapsed));
  }

  /** Áp trạng thái đã nhớ (gọi lại khi một thẻ vẽ lại tiêu đề của nó). */
  function init(root = document) {
    const set = load();
    root.querySelectorAll('.card[data-collapse]').forEach((card) => apply(card, set.has(card.dataset.collapse)));
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.side-toggle');
    const card = btn && btn.closest('.card[data-collapse]');
    if (!card) return;
    const collapsed = !card.classList.contains('collapsed');
    const set = load();
    if (collapsed) set.add(card.dataset.collapse);
    else set.delete(card.dataset.collapse);
    save(set);
    apply(card, collapsed);
  });

  window.SideCards = { init };
  init();
})();
