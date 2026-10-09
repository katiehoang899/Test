'use strict';

// Thanh điều hướng dưới header: breadcrumb (Trang chủ › Kịch bản › Người tham gia › Báo cáo)
// và nút ‹ Trước / Sau › để chuyển giữa các phiên cùng kịch bản (trang báo cáo, transcript).
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let builder = null;
  let pager = null;
  let scenarioCache = null;

  function bar() {
    let el = document.getElementById('crumbBar');
    if (!el) {
      el = document.createElement('div');
      el.id = 'crumbBar';
      el.className = 'crumb-bar';
      const header = document.querySelector('.app-header');
      header.insertAdjacentElement('afterend', el);
    }
    return el;
  }

  function render() {
    if (!builder) return;
    const crumbs = builder();
    const items = crumbs.map((c, i) => {
      const last = i === crumbs.length - 1;
      const label = esc(c.label);
      return `<li>${last || !c.href ? `<span${last ? ' aria-current="page"' : ''}>${label}</span>` : `<a href="${esc(c.href)}">${label}</a>`}</li>`;
    }).join('');
    let pagerHtml = '';
    if (pager && pager.total > 1) {
      const link = (s, dir) => (s
        ? `<a class="btn pager-btn" href="${esc(pager.href(s))}" rel="${dir}" title="${esc(s.participant || t('common.anonymous'))}">${dir === 'prev' ? '‹ ' + esc(t('nav.prev')) : esc(t('nav.next')) + ' ›'}<span class="pager-name">${esc(s.participant || t('common.anonymous'))}</span></a>`
        : `<span class="btn pager-btn" aria-disabled="true">${dir === 'prev' ? '‹ ' + esc(t('nav.prev')) : esc(t('nav.next')) + ' ›'}</span>`);
      pagerHtml = `<div class="pager" aria-label="${esc(t('nav.pager'))}">
        ${link(pager.prev, 'prev')}
        <span class="small muted pager-pos">${esc(t('nav.position', { i: pager.index + 1, n: pager.total }))}</span>
        ${link(pager.next, 'next')}
      </div>`;
    }
    bar().innerHTML = `<nav class="breadcrumb" aria-label="Breadcrumb"><ol>${items}</ol></nav>${pagerHtml}`;
  }

  /** Danh sách kịch bản (đọc một lần) để hiện tên kịch bản trong breadcrumb. */
  async function scenarios() {
    if (!scenarioCache) {
      scenarioCache = await fetch('/__et/api/scenarios').then((r) => (r.ok ? r.json() : [])).catch(() => []);
    }
    return scenarioCache;
  }

  /** Mục breadcrumb của kịch bản chứa phiên (về trang Người tham gia của kịch bản đó). */
  function scenarioCrumb(meta, list) {
    const sc = meta && meta.scenarioId && list.find((x) => x.id === meta.scenarioId);
    return sc
      ? { label: sc.name, href: '/__et/participants.html?scenario=' + encodeURIComponent(sc.id) }
      : { label: t('home.unassigned'), href: '/__et/?scenario=none' };
  }

  /**
   * Phiên trước / sau trong cùng kịch bản, theo thứ tự ghi (cũ → mới).
   * hrefOf(session) → đường dẫn tới trang tương ứng của phiên đó.
   */
  async function setupPager(meta, hrefOf) {
    const scope = meta.scenarioId || 'none';
    const list = await fetch('/__et/api/sessions?scenario=' + encodeURIComponent(scope)).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const ordered = list.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const index = ordered.findIndex((s) => s.id === meta.id);
    if (index < 0) return;
    pager = { index, total: ordered.length, prev: ordered[index - 1] || null, next: ordered[index + 1] || null, href: hrefOf };
    render();
  }

  // phím tắt: Alt + ← / → để sang phiên trước / sau
  document.addEventListener('keydown', (e) => {
    if (!pager || !e.altKey || e.ctrlKey || e.metaKey) return;
    if (/^(input|textarea|select)$/i.test(document.activeElement.tagName) || document.activeElement.isContentEditable) return;
    const target = e.key === 'ArrowLeft' ? pager.prev : e.key === 'ArrowRight' ? pager.next : null;
    if (!target) return;
    e.preventDefault();
    location.href = pager.href(target);
  });

  document.addEventListener('i18n:change', render);

  window.Nav = {
    /** builder() → [{ label, href? }]; được gọi lại khi đổi ngôn ngữ. */
    breadcrumb(fn) {
      builder = fn;
      render();
    },
    refresh: render,
    scenarios,
    scenarioCrumb,
    setupPager,
    home: () => ({ label: t('nav.home'), href: '/__et/' }),
    scenariosRoot: () => ({ label: t('nav.scenarios'), href: '/__et/scenarios.html' }),
  };
})();
