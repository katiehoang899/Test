'use strict';

// Ghi chú cho một phiên (trang Báo cáo, Transcript): nhận xét, vấn đề phát hiện, việc cần làm…
// Tự lưu sau khi ngừng gõ ~1 giây, khi rời ô nhập và khi đóng trang.
(function () {
  const SAVE_DELAY_MS = 1000;

  /**
   * host: phần tử card chứa ghi chú; meta: dữ liệu phiên (id, note, noteUpdatedAt, noteBy).
   * Gọi lại khi đổi ngôn ngữ thì chỉ cập nhật nhãn, không mất nội dung đang gõ.
   */
  function mount(host, meta) {
    host.innerHTML = `<div class="sessions-head">
        <h2 style="margin: 0"><label for="noteText" id="noteTitle"></label></h2>
        <span class="small muted" id="noteState" role="status" aria-live="polite"></span>
      </div>
      <textarea id="noteText" class="note-text" rows="5" maxlength="20000"></textarea>`;
    const ta = host.querySelector('#noteText');
    const state = host.querySelector('#noteState');
    ta.value = meta.note || '';

    let saved = ta.value;
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
      ta.placeholder = t('note.placeholder');
      if (error) state.textContent = t('note.error', { error });
      else if (ta.value !== saved) state.textContent = t('note.unsaved');
      else if (inflight) state.textContent = t('note.saving');
      else if (info.at && saved) state.textContent = info.by ? t('note.saved_by', { time: fmtTime(info.at), name: info.by }) : t('note.saved', { time: fmtTime(info.at) });
      else state.textContent = '';
      state.classList.toggle('form-error', !!error);
    }

    async function save() {
      clearTimeout(timer);
      timer = null;
      if (inflight) await inflight.catch(() => {});
      const value = ta.value;
      if (value === saved) return renderLabels();
      inflight = fetch(`/__et/api/sessions/${encodeURIComponent(meta.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: value }),
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

    ta.addEventListener('input', () => {
      error = null;
      renderLabels();
      clearTimeout(timer);
      timer = setTimeout(save, SAVE_DELAY_MS);
    });
    ta.addEventListener('blur', () => { if (ta.value !== saved) save(); });
    // đóng / rời trang khi chưa kịp lưu: gửi nốt (keepalive vẫn chạy sau khi trang đóng)
    window.addEventListener('pagehide', () => {
      if (ta.value === saved) return;
      fetch(`/__et/api/sessions/${encodeURIComponent(meta.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: ta.value }),
        keepalive: true,
      }).catch(() => {});
    });
    document.addEventListener('i18n:change', renderLabels);
    renderLabels();
  }

  window.SessionNote = { mount };
})();
