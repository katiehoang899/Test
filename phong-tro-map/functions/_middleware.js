// Cloudflare Pages Functions: bảo vệ cả trang bằng mật khẩu (biến bí mật APP_PASSWORD, đặt khi
// chạy deploy-cloudflare.command). Trang trên mạng thì ai có link cũng mở được: không có mật khẩu,
// người lạ sửa / xoá được tin đã lưu, điểm ngập, đỗ xe của bạn.
// Đăng nhập một lần, trình duyệt nhớ 1 năm (cookie). Đổi mật khẩu thì mọi máy phải đăng nhập lại.

const COOKIE = 'rentmaps_auth';

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cookieOf(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

function loginPage(error, next) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return new Response(`<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Đăng nhập · RentMAPs</title><link rel="icon" href="/favicon.ico?v=blue"><meta name="theme-color" content="#1868DB">
<style>
:root { color-scheme: light dark; --bg: #F8F8F8; --card: #FFF; --text: #292A2E; --sub: #6B6E76; --border: #8C8F97; --brand: #1868DB; --brand-h: #1558BC; --danger: #AE2E24; --danger-bg: #FFECEB; }
@media (prefers-color-scheme: dark) { :root { --bg: #18191A; --card: #242528; --text: #CECFD2; --sub: #96999E; --border: #7E8188; --brand: #669DF1; --brand-h: #8FB8F6; --danger: #FD9891; --danger-bg: #42221F; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text);
  font: 400 14px/20px "Atlassian Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, "Helvetica Neue", sans-serif; }
form { width: min(360px, 100%); padding: 32px 24px; border-radius: 12px; background: var(--card);
  box-shadow: 0 8px 12px #1E1F2126, 0 0 1px #1E1F214F; display: grid; gap: 16px; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 653; font-size: 20px; line-height: 24px; }
p { margin: 0; color: var(--sub); }
label { display: grid; gap: 4px; font-size: 12px; line-height: 16px; font-weight: 600; color: var(--sub); }
input { height: 40px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 14px; }
input:focus { outline: none; border-color: #4688EC; box-shadow: inset 0 0 0 1px #4688EC; }
button { height: 40px; border: 0; border-radius: 6px; background: var(--brand); color: #FFF; font: inherit; font-weight: 500; cursor: pointer; }
button:hover { background: var(--brand-h); }
.err { padding: 8px 12px; border-radius: 6px; background: var(--danger-bg); color: var(--danger); }
</style></head><body>
<form method="post" action="/login">
  <div class="brand"><img src="/logo.svg?v=blue" alt="" width="32" height="32"> RentMAPs</div>
  <p>Nhập mật khẩu để mở RentMAPs.</p>
  ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
  <label>Mật khẩu<input type="password" name="password" autocomplete="current-password" autofocus required></label>
  <input type="hidden" name="next" value="${esc(next)}">
  <button type="submit">Đăng nhập</button>
</form></body></html>`, { status: error ? 401 : 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function onRequest({ request, env, next }) {
  const password = env.APP_PASSWORD;
  if (!password) return next(); // chưa đặt mật khẩu: mở tự do
  const url = new URL(request.url);
  const token = await sha256('rentmaps:' + password);
  // Logo / icon hiện được ở trang đăng nhập.
  if (/^\/(logo\.svg|favicon\.ico|apple-touch-icon\.png)$/.test(url.pathname)) return next();

  if (url.pathname === '/login') {
    const back = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');
    if (request.method !== 'POST') return loginPage('', back(url.searchParams.get('next')));
    const form = await request.formData();
    if (form.get('password') !== password) {
      await new Promise((r) => setTimeout(r, 1000)); // chậm lại khi đoán sai
      return loginPage('Mật khẩu chưa đúng.', back(form.get('next')));
    }
    return new Response(null, {
      status: 303,
      headers: {
        Location: back(form.get('next')),
        'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  if (cookieOf(request, COOKIE) === token) return next();
  if (url.pathname.startsWith('/api/')) {
    return Response.json({ error: 'Cần đăng nhập. Tải lại trang để nhập mật khẩu.' }, { status: 401 });
  }
  return Response.redirect(new URL('/login?next=' + encodeURIComponent(url.pathname + url.search), url), 302);
}
