'use strict';

const $ = (s) => document.querySelector(s);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('#startForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#formError').textContent = '';
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: $('#url').value,
        participant: $('#participant').value,
        eyeTracking: $('#eyeTracking').checked,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không tạo được phiên');
    location.href = '/track.html?id=' + data.id;
  } catch (err) {
    $('#formError').textContent = err.message;
  }
});

async function loadSessions() {
  const tbody = $('#sessions');
  try {
    const list = await (await fetch('/api/sessions')).json();
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">Chưa có phiên nào.</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((s) => {
      const acc = s.calibration && s.calibration.accuracy != null
        ? `<span class="tag ${s.calibration.accuracy >= 70 ? 'ok' : 'warn'}">${Math.round(s.calibration.accuracy)}%</span>`
        : s.eyeTracking ? '<span class="tag warn">chưa hiệu chỉnh</span>' : '<span class="tag">tắt</span>';
      return `<tr>
        <td>${esc(new Date(s.createdAt).toLocaleString('vi-VN'))}</td>
        <td class="url">${esc(s.url)}</td>
        <td>${esc(s.participant || '—')}</td>
        <td>${s.eventCount || 0}</td>
        <td>${acc}</td>
        <td style="white-space: nowrap">
          <a class="btn" href="/report.html?id=${s.id}">Báo cáo</a>
          <button class="danger" data-del="${s.id}" title="Xoá phiên">✕</button>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6">Lỗi: ${esc(err.message)}</td></tr>`;
  }
}

$('#sessions').addEventListener('click', async (e) => {
  const id = e.target.dataset && e.target.dataset.del;
  if (!id || !confirm('Xoá phiên này và toàn bộ dữ liệu?')) return;
  await fetch('/api/sessions/' + id, { method: 'DELETE' });
  loadSessions();
});

$('#reload').addEventListener('click', loadSessions);
loadSessions();
