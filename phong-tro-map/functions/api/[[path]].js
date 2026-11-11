// Cloudflare Pages Functions: mọi đường dẫn /api/* của RentMAPs.
// Dùng chung lõi xử lý với bản chạy trên máy (lib/api.js); dữ liệu (tin đã lưu, điểm ngập, đỗ xe,
// cache geocode) lưu trong Cloudflare D1 (binding DB, khai báo trong wrangler.toml).
import RentApi from '../../lib/api.js';

// Bảng key → JSON. D1 ghi xong đọc thấy ngay (KV thì trễ tới ~60 giây, thêm 2 điểm liền nhau dễ mất 1).
async function d1Store(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
  return {
    async get(key) {
      const row = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first();
      return row ? JSON.parse(row.value) : undefined;
    },
    async put(key, value) {
      await db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(key, JSON.stringify(value)).run();
    },
  };
}

let api = null; // tạo một lần cho mỗi isolate (giữ cache trong bộ nhớ giữa các request)

export async function onRequest({ request, env }) {
  if (!env.DB) {
    return Response.json({ error: 'Chưa gắn cơ sở dữ liệu D1 (binding DB). Chạy lại deploy-cloudflare.command.' }, { status: 500 });
  }
  if (!api) {
    api = RentApi.createApi({
      store: await d1Store(env.DB),
      gateway: env.CHOTOT_GATEWAY,
      nominatim: env.NOMINATIM_URL,
      osrm: env.OSRM_URL,
      overpass: env.OVERPASS_URL || undefined,
    });
  }
  const readText = async (limit) => {
    const text = await request.text();
    if (text.length > limit) throw Object.assign(new Error('Body quá lớn'), { status: 413 });
    return text;
  };
  const out = await api.handle(request.method, new URL(request.url), request.headers.get('content-type'), readText);
  if (!out) return new Response('Not found', { status: 404 });
  return new Response(JSON.stringify(out.body, null, out.pretty ? 2 : 0), {
    status: out.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
