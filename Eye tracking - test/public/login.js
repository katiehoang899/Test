'use strict';

// Đăng nhập: admin vào trang chủ Heatmap, người tham gia (guest) vào trang kịch bản của mình.
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

// link mời có sẵn tên đăng nhập: /__et/login.html?u=<tên>
if (params.get('u')) {
  $('#username').value = params.get('u');
  setTimeout(() => $('#password').focus(), 0);
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  $('#loginBtn').disabled = true;
  try {
    const res = await fetch('/__et/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#username').value.trim(), password: $('#password').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    // chỉ quay lại đường dẫn nội bộ của công cụ
    const next = params.get('next') || '';
    const safeNext = /^\/__et\/[^/]/.test(next) || next === '/__et/' ? next : '';
    location.href = data.user.role === 'admin' ? safeNext || '/__et/' : '/__et/guest.html';
  } catch (err) {
    $('#loginError').textContent = err.message;
    $('#password').select();
  } finally {
    $('#loginBtn').disabled = false;
  }
});

// ---------- quên mật khẩu: dùng mã khôi phục ----------

function showRecover(show) {
  $('#loginForm').hidden = show;
  $('#recoverForm').hidden = !show;
  if (show) {
    $('#recUsername').value = $('#username').value;
    ($('#recUsername').value ? $('#recCode') : $('#recUsername')).focus();
  } else {
    $('#username').focus();
  }
}
$('#showRecover').addEventListener('click', () => showRecover(true));
$('#backToLogin').addEventListener('click', () => showRecover(false));

$('#recoverForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#recError').textContent = '';
  $('#recBtn').disabled = true;
  try {
    const res = await fetch('/__et/api/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#recUsername').value.trim(), code: $('#recCode').value, password: $('#recPassword').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    // báo số mã còn lại ở trang sau
    try { sessionStorage.setItem('heatmap.recovered', String(data.remaining)); } catch { /* bỏ qua */ }
    location.href = data.user.role === 'admin' ? '/__et/' : '/__et/guest.html';
  } catch (err) {
    $('#recError').textContent = err.message;
  } finally {
    $('#recBtn').disabled = false;
  }
});

document.querySelectorAll('.lang-switch button').forEach((b) => b.addEventListener('click', () => I18N.setLanguage(b.dataset.lang)));
document.addEventListener('i18n:change', (e) => {
  document.querySelectorAll('.lang-switch button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.lang === e.detail.language)));
});

I18N.load().then(() => {
  if (!params.get('u')) $('#username').focus();
});
