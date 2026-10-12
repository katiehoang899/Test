'use strict';

// Ghi chú cho một phiên (trang Báo cáo, Transcript), soạn bằng trình soạn thảo chung (rte.js).
// Tự lưu sau khi ngừng gõ ~1 giây, khi rời ô và khi đóng trang.
(function () {
  const SAVE_DELAY_MS = 1000;

  /**
   * host: phần tử card chứa ghi chú; meta: dữ liệu phiên (id, note, noteFormat, noteUpdatedAt, noteBy).
   */
  function mount(host, meta) {
    host.innerHTML = `<div class="sessions-head">
        <h2 style="margin: 0" id="noteTitle"></h2>
        <span class="small muted" id="noteState" role="status" aria-live="polite"></span>
      </div>
      <div id="noteRte"></div>`;
    const state = host.querySelector('#noteState');

    let saved = '';
    let info = { at: meta.noteUpdatedAt || null, by: meta.noteBy || null };
    let timer = null;
    let inflight = null;
    let error = null;

    const fmtTime = (iso) => {
      const d = new Date(iso);
      const sameDay = d.toDateString() === new Date().toDateString();
      return sameDay ? d.toLocaleTimeString(I18N.locale(), { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(I18N.locale());
    };

    function renderLabels() {
      host.querySelector('#noteTitle').textContent = t('note.title');
      if (error) state.textContent = t('note.error', { error });
      else if (editor.getHtml() !== saved) state.textContent = t('note.unsaved');
      else if (inflight) state.textContent = t('note.saving');
      else if (info.at && saved) state.textContent = info.by ? t('note.saved_by', { time: fmtTime(info.at), name: info.by }) : t('note.saved', { time: fmtTime(info.at) });
      else state.textContent = '';
      state.classList.toggle('form-error', !!error);
    }

    const body = (value) => JSON.stringify({ note: value, noteFormat: 'html' });

    async function save() {
      clearTimeout(timer);
      timer = null;
      if (inflight) await inflight.catch(() => {});
      const value = editor.getHtml();
      if (value === saved) return renderLabels();
      inflight = fetch(`/__et/api/sessions/${encodeURIComponent(meta.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: body(value),
      }).then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
        saved = value;
        info = { at: data.noteUpdatedAt || null, by: data.noteBy || null };
        error = null;
      });
      renderLabels();
      try {
        await inflight;
      } catch (err) {
        error = err.message;
      } finally {
        inflight = null;
        renderLabels();
      }
    }

    const editor = RichEditor.create(host.querySelector('#noteRte'), {
      id: 'noteEditor',
      html: RichEditor.toSafeHtml(meta.note, meta.noteFormat),
      labelledBy: 'noteTitle',
      placeholderKey: 'note.placeholder',
      onChange() {
        error = null;
        renderLabels();
        clearTimeout(timer);
        timer = setTimeout(save, SAVE_DELAY_MS);
      },
      onBlur() { if (editor.getHtml() !== saved) save(); },
    });
    saved = editor.getHtml();

    // đóng / rời trang khi chưa kịp lưu: gửi nốt (keepalive vẫn chạy sau khi trang đóng)
    window.addEventListener('pagehide', () => {
      const value = editor.getHtml();
      if (value === saved) return;
      fetch(`/__et/api/sessions/${encodeURIComponent(meta.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: body(value),
        keepalive: true,
      }).catch(() => {});
    });
    document.addEventListener('i18n:change', renderLabels);
    renderLabels();
  }

  window.SessionNote = { mount };
})();
