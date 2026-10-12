'use strict';

// Trình soạn thảo có định dạng dùng chung (Ghi chú của phiên, Hướng dẫn nhiệm vụ của kịch bản…):
// đậm, nghiêng, gạch chân, gạch ngang, tiêu đề, danh sách, trích dẫn, link; gõ tắt "- ", "1. ", "> ".
// Nội dung là HTML nhưng LUÔN được làm sạch theo danh sách thẻ cho phép trước khi hiện ra
// (nội dung do người khác viết, dán từ web…), nên không chạy được script hay nhúng nội dung lạ.
(function () {
  // ---------- làm sạch HTML ----------

  // thẻ được giữ (thẻ tương đương được quy về một dạng); thẻ khác bị bỏ nhưng giữ chữ bên trong
  const ALLOWED = {
    B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', S: 's', STRIKE: 's', DEL: 's',
    P: 'p', DIV: 'p', BR: 'br', H1: 'h3', H2: 'h3', H3: 'h3', H4: 'h3', H5: 'h3', H6: 'h3',
    UL: 'ul', OL: 'ol', LI: 'li', BLOCKQUOTE: 'blockquote', A: 'a', CODE: 'code',
  };
  const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE']);
  // bỏ hẳn cả nội dung
  const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'HEAD', 'TITLE', 'META', 'LINK', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS']);

  function safeHref(raw) {
    const v = String(raw || '').trim();
    if (!v) return null;
    try {
      const u = new URL(/^[a-z][\w+.-]*:/i.test(v) ? v : 'https://' + v);
      return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  }

  function copyClean(from, to) {
    for (const n of from.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        to.appendChild(document.createTextNode(n.nodeValue));
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE || DROP.has(n.tagName)) continue;
      const tag = ALLOWED[n.tagName];
      // span, font… → chỉ giữ chữ; đoạn / tiêu đề lại chứa khối khác (danh sách trong tiêu đề…) → bỏ lớp ngoài
      if (!tag || ((tag === 'p' || tag === 'h3') && [...n.children].some((c) => BLOCK_TAGS.has(c.tagName)))) {
        copyClean(n, to);
        continue;
      }
      const el = document.createElement(tag);
      if (tag === 'a') {
        const href = safeHref(n.getAttribute('href'));
        if (!href) {
          copyClean(n, to);
          continue;
        }
        el.setAttribute('href', href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
      if (tag !== 'br') copyClean(n, el);
      to.appendChild(el);
    }
  }

  /** HTML bất kỳ → HTML chỉ gồm thẻ cho phép. DOMParser không chạy script, không tải ảnh. */
  function sanitize(html) {
    const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
    const out = document.createElement('div');
    copyClean(doc.body, out);
    return out.innerHTML;
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Chữ thường (nội dung cũ) → đoạn văn. */
  const textToHtml = (text) => String(text).split(/\n/).map((line) => `<p>${escapeHtml(line) || '<br>'}</p>`).join('');

  /** Nội dung đã lưu ({ html? , format }) → HTML sạch để hiện ra. */
  const toSafeHtml = (value, format) => (!value ? '' : format === 'html' ? sanitize(value) : textToHtml(value));

  /** HTML → chữ thường. */
  function toText(html) {
    const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
    doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    doc.querySelectorAll('p, h3, li, blockquote').forEach((el) => el.append('\n'));
    doc.querySelectorAll('li').forEach((el) => el.prepend('• '));
    return doc.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---------- thanh công cụ ----------

  const TOOLS = [
    { cmd: 'bold', label: 'B', key: 'note.bold', shortcut: 'Ctrl+B', cls: 'tb-bold' },
    { cmd: 'italic', label: 'I', key: 'note.italic', shortcut: 'Ctrl+I', cls: 'tb-italic' },
    { cmd: 'underline', label: 'U', key: 'note.underline', shortcut: 'Ctrl+U', cls: 'tb-underline' },
    { cmd: 'strikeThrough', label: 'S', key: 'note.strike', cls: 'tb-strike' },
    { sep: true },
    { block: 'h3', label: 'H', key: 'note.heading', cls: 'tb-heading' },
    { cmd: 'insertUnorderedList', label: '•≡', key: 'note.bullets' },
    { cmd: 'insertOrderedList', label: '1.', key: 'note.numbers' },
    { block: 'blockquote', label: '❝', key: 'note.quote' },
    { sep: true },
    { act: 'link', label: '🔗', key: 'note.link', shortcut: 'Ctrl+K' },
    { act: 'clear', label: 'T̸', key: 'note.clear' },
  ];

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const shortcutText = (s) => (isMac ? s.replace('Ctrl+', '⌘') : s);

  /**
   * Tạo trình soạn thảo trong `container`.
   * opts: { id (của vùng soạn), html (ban đầu, đã làm sạch hoặc chưa), labelledBy, placeholderKey (khoá i18n),
   *         onChange() — sau mỗi lần sửa, onBlur() }
   * Trả về { el, getHtml() (đã làm sạch, '' nếu trống), setHtml(html), isEmpty(), renderLabels() }.
   */
  function create(container, opts = {}) {
    container.innerHTML = `<div class="rte">
        <div class="rte-toolbar" role="toolbar" aria-controls="${escapeHtml(opts.id)}">${TOOLS.map((tool, i) => (tool.sep
    ? '<span class="rte-sep" aria-hidden="true"></span>'
    : `<button type="button" class="${tool.cls || ''}" data-tool="${i}" tabindex="${i ? -1 : 0}">${tool.label}</button>`)).join('')}</div>
        <div class="rte-body" id="${escapeHtml(opts.id)}" contenteditable="true" role="textbox" aria-multiline="true" ${opts.labelledBy ? `aria-labelledby="${escapeHtml(opts.labelledBy)}"` : ''} spellcheck="true"></div>
      </div>`;
    const ed = container.querySelector('.rte-body');
    const bar = container.querySelector('.rte-toolbar');
    const buttons = [...bar.querySelectorAll('button')];

    try {
      document.execCommand('styleWithCSS', false, false); // <b>, <i>… thay vì style="…"
      document.execCommand('defaultParagraphSeparator', false, 'p');
    } catch { /* trình duyệt cũ */ }

    const isEmpty = () => !ed.textContent.trim() && !ed.querySelector('li');
    const getHtml = () => (isEmpty() ? '' : sanitize(ed.innerHTML));
    const setHtml = (html) => {
      ed.innerHTML = sanitize(html) || '<p><br></p>'; // ô trống bắt đầu bằng một đoạn để chữ luôn nằm trong <p>
      renderLabels();
    };
    const changed = () => {
      normalize();
      ensureParagraph();
      renderLabels();
      renderActive();
      if (opts.onChange) opts.onChange();
    };

    function renderLabels() {
      if (opts.placeholderKey) ed.dataset.placeholder = t(opts.placeholderKey);
      bar.setAttribute('aria-label', t('note.toolbar'));
      buttons.forEach((b) => {
        const tool = TOOLS[b.dataset.tool];
        const name = t(tool.key);
        b.title = tool.shortcut ? `${name} (${shortcutText(tool.shortcut)})` : name;
        b.setAttribute('aria-label', name);
      });
      ed.classList.toggle('is-empty', isEmpty());
    }

    // nút đang bật (đậm, danh sách…) theo vị trí con trỏ
    function renderActive() {
      if (!ed.contains(document.getSelection().anchorNode)) return;
      const block = String(document.queryCommandValue('formatBlock') || '').toLowerCase();
      buttons.forEach((b) => {
        const tool = TOOLS[b.dataset.tool];
        let on = false;
        try {
          if (tool.cmd) on = document.queryCommandState(tool.cmd);
          else if (tool.block) on = block === tool.block;
        } catch { /* bỏ qua */ }
        b.setAttribute('aria-pressed', String(on));
      });
    }

    const placeCaret = (node, offset) => {
      const r = document.createRange();
      r.setStart(node, offset);
      r.collapse(true);
      const s = document.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    };

    // Chrome đôi khi đặt danh sách / trích dẫn vào trong <p> hoặc <h3>: bỏ lớp ngoài, giữ nguyên con trỏ
    function normalize() {
      const sel = document.getSelection();
      const caret = sel.rangeCount && ed.contains(sel.anchorNode) ? [sel.anchorNode, sel.anchorOffset] : null;
      let fixed = false;
      for (const el of ed.querySelectorAll('p, h3')) {
        if (![...el.children].some((c) => BLOCK_TAGS.has(c.tagName))) continue;
        el.replaceWith(...el.childNodes);
        fixed = true;
      }
      if (fixed && caret && caret[0].isConnected) {
        placeCaret(caret[0], Math.min(caret[1], caret[0].nodeType === Node.TEXT_NODE ? caret[0].length : caret[0].childNodes.length));
      }
    }

    // xoá hết (Ctrl+A, Delete) → đặt lại một đoạn trống
    function ensureParagraph() {
      if (ed.firstElementChild || ed.textContent) return;
      ed.innerHTML = '<p><br></p>';
      if (document.activeElement === ed) placeCaret(ed.firstChild, 0);
    }

    function run(tool) {
      ed.focus();
      if (tool.cmd) document.execCommand(tool.cmd);
      else if (tool.block) {
        const cur = String(document.queryCommandValue('formatBlock') || '').toLowerCase();
        document.execCommand('formatBlock', false, cur === tool.block ? 'p' : tool.block);
      } else if (tool.act === 'link') return linkFlow();
      else if (tool.act === 'clear') {
        document.execCommand('removeFormat');
        document.execCommand('formatBlock', false, 'p');
      }
      changed();
    }

    // ---- hỏi link: dialog trong trang (prompt() không chạy trong app desktop) ----
    function linkFlow() {
      const sel = document.getSelection();
      const savedRange = sel.rangeCount && ed.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
      const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
      const existing = node && ed.contains(node) ? node.closest('a') : null;
      let dlg = document.getElementById('rteLinkDialog');
      if (!dlg) {
        dlg = document.createElement('dialog');
        dlg.id = 'rteLinkDialog';
        dlg.className = 'settings note-link-dialog';
        document.body.appendChild(dlg);
      }
      dlg.innerHTML = `<form method="dialog">
          <label for="rteLinkInput">${escapeHtml(t('note.link_prompt'))}</label>
          <input type="text" id="rteLinkInput" spellcheck="false" placeholder="https://" value="${escapeHtml(existing ? existing.getAttribute('href') : '')}">
          <p class="small form-error" id="rteLinkError" role="alert"></p>
          <div class="row" style="justify-content: space-between; gap: 6px">
            <span>${existing ? `<button type="button" id="rteUnlink">${escapeHtml(t('note.unlink'))}</button>` : ''}</span>
            <span class="row" style="gap: 6px"><button type="button" id="rteLinkCancel">${escapeHtml(t('note.cancel'))}</button><button type="submit" class="primary">OK</button></span>
          </div>
        </form>`;
      const input = dlg.querySelector('#rteLinkInput');
      const restore = () => {
        ed.focus();
        if (savedRange) {
          const s = document.getSelection();
          s.removeAllRanges();
          s.addRange(savedRange);
        }
      };
      dlg.querySelector('#rteLinkCancel').addEventListener('click', () => {
        dlg.close();
        restore();
      });
      const unlink = dlg.querySelector('#rteUnlink');
      if (unlink) {
        unlink.addEventListener('click', () => {
          dlg.close();
          restore();
          const r = document.createRange();
          r.selectNodeContents(existing);
          const s = document.getSelection();
          s.removeAllRanges();
          s.addRange(r);
          document.execCommand('unlink');
          changed();
        });
      }
      dlg.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        const raw = input.value.trim();
        const href = safeHref(raw);
        if (!href) {
          dlg.querySelector('#rteLinkError').textContent = t('note.link_invalid');
          return;
        }
        dlg.close(); // dialog modal làm phần còn lại của trang "inert": phải đóng trước khi chèn
        restore();
        if (existing) {
          existing.setAttribute('href', href);
        } else if (document.getSelection().isCollapsed) {
          document.execCommand('insertHTML', false, `<a href="${escapeHtml(href)}">${escapeHtml(raw)}</a>&nbsp;`);
        } else {
          document.execCommand('createLink', false, href);
        }
        changed();
      });
      dlg.showModal();
      input.focus();
      input.select();
    }

    bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // giữ vùng chọn trong ô soạn
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tool]');
      if (b) run(TOOLS[b.dataset.tool]);
    });
    // phím ← → di chuyển giữa các nút của thanh công cụ
    bar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const i = buttons.indexOf(document.activeElement);
      if (i < 0) return;
      const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
      buttons.forEach((b) => b.setAttribute('tabindex', '-1'));
      next.setAttribute('tabindex', '0');
      next.focus();
      e.preventDefault();
    });

    ed.addEventListener('input', changed);
    ed.addEventListener('blur', () => { if (opts.onBlur) opts.onBlur(); });
    ed.addEventListener('keydown', (e) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        linkFlow();
      }
    });
    // gõ nhanh kiểu Markdown ở đầu dòng: "- " → danh sách, "1. " → danh sách số, "> " → trích dẫn
    ed.addEventListener('keyup', (e) => {
      if (e.key !== ' ') return;
      const sel = document.getSelection();
      const node = sel.anchorNode;
      if (!node || node.nodeType !== Node.TEXT_NODE || !ed.contains(node)) return;
      const before = node.nodeValue.slice(0, sel.anchorOffset).replace(/ /g, ' ');
      const inner = node.parentElement.closest('p, li, h3, blockquote');
      const block = inner && ed.contains(inner) ? inner : ed;
      if (block.tagName === 'LI' || block.textContent.replace(/ /g, ' ').indexOf(before) !== 0) return;
      const rule = { '- ': 'insertUnorderedList', '* ': 'insertUnorderedList', '1. ': 'insertOrderedList', '> ': 'quote' }[before];
      if (!rule) return;
      // xoá ký tự gõ tắt bằng execCommand để giữ con trỏ và Ctrl+Z
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, sel.anchorOffset);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete');
      if (rule === 'quote') {
        document.execCommand('formatBlock', false, 'blockquote');
      } else {
        if (block.tagName === 'H3' || block.tagName === 'BLOCKQUOTE') document.execCommand('formatBlock', false, 'p'); // danh sách không nằm trong tiêu đề
        document.execCommand(rule);
      }
      changed();
    });
    // dán: chỉ giữ định dạng cho phép
    ed.addEventListener('paste', (e) => {
      const html = e.clipboardData.getData('text/html');
      const text = e.clipboardData.getData('text/plain');
      if (!html && !text) return;
      e.preventDefault();
      document.execCommand('insertHTML', false, html ? sanitize(html) : textToHtml(text));
    });
    // Ctrl/⌘ + click để mở link (bấm thường là để sửa chữ)
    ed.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (!a || !(isMac ? e.metaKey : e.ctrlKey)) return;
      e.preventDefault();
      window.open(a.href, '_blank', 'noopener');
    });
    document.addEventListener('selectionchange', renderActive);
    document.addEventListener('i18n:change', renderLabels);

    setHtml(opts.html || '');
    return { el: ed, getHtml, setHtml, isEmpty, renderLabels };
  }

  window.RichEditor = { create, sanitize, toText, textToHtml, toSafeHtml };
})();
