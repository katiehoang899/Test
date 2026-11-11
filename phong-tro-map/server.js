'use strict';

// RentMAPs: hiển thị tin cho thuê phòng trọ của Nhà Tốt (nhatot.com / Chợ Tốt)
// dạng danh sách + bản đồ. Server này chỉ làm proxy tới API công khai của Chợ Tốt
// (gateway.chotot.com) để trình duyệt không bị chặn CORS, kèm cache và geocode.
// Phần xử lý /api/ nằm trong lib/api.js (dùng chung với bản Cloudflare trong functions/);
// file này lo phần riêng của Node: phục vụ file tĩnh và lưu dữ liệu ra thư mục data/.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApi } = require('./lib/api.js');

const PORT = Number(process.env.PORT) || 3100;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- lưu dữ liệu ra file ----------

// Khoá của store → file trong DATA_DIR: saved.json, floods.json, parking.json; các khoá geo:<địa chỉ>
// gộp chung trong geocode-cache.json (giống trước đây, dữ liệu cũ đọc được ngay).
function fileStore(dir) {
  const cache = new Map(); // tên file → nội dung đã đọc
  const timers = new Map();
  const fileOf = (key) => (key.startsWith('geo:') ? 'geocode-cache' : key);
  const read = (name) => {
    if (!cache.has(name)) {
      let v;
      try { v = JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8')); } catch { v = undefined; }
      cache.set(name, v);
    }
    return cache.get(name);
  };
  const write = (name) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(cache.get(name)));
  };
  return {
    async get(key) {
      const name = fileOf(key);
      if (name !== key) {
        const geo = read(name) || {};
        return key.slice(4) in geo ? geo[key.slice(4)] : undefined;
      }
      const v = read(name);
      return v === undefined ? undefined : structuredClone(v);
    },
    async put(key, value) {
      const name = fileOf(key);
      if (name !== key) {
        // Cache geocode: ghi gộp sau 1 giây (nhiều địa chỉ liền nhau chỉ ghi file một lần).
        cache.set(name, { ...(read(name) || {}), [key.slice(4)]: value });
        clearTimeout(timers.get(name));
        const t = setTimeout(() => { try { write(name); } catch { /* cache chỉ là phụ */ } }, 1000);
        t.unref?.();
        timers.set(name, t);
        return;
      }
      cache.set(name, structuredClone(value));
      write(name);
    },
  };
}

const api = createApi({
  store: fileStore(DATA_DIR),
  gateway: process.env.CHOTOT_GATEWAY,
  nominatim: process.env.NOMINATIM_URL,
  osrm: process.env.OSRM_URL,
  overpass: process.env.OVERPASS_URL || undefined, // đặt OVERPASS_URL thì chỉ dùng máy chủ đó
  geoDelay: !process.env.NOMINATIM_URL, // Nominatim thật: 1 request/giây
});

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body quá lớn'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// File tĩnh luôn được trình duyệt kiểm tra lại (no-cache + ETag): cập nhật code là thấy ngay,
// file không đổi thì trả 304 (không tải lại).
function serveStatic(pathname, req, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.stat(file, (statErr, st) => {
    if (statErr || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = { 'Cache-Control': 'no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    try {
      const out = await api.handle(req.method, u, req.headers['content-type'], (limit) => readBody(req, limit));
      if (!out) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
        return serveStatic(u.pathname, req, res);
      }
      if (!out.pretty) return sendJson(res, out.status, out.body);
      res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(out.body, null, 2)); // trang kiểm tra: xuống dòng cho dễ đọc / copy
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message || 'Lỗi không xác định' });
    }
  });
}

if (require.main === module) {
  // Mặc định chỉ nghe trên máy này (localhost). HOST=0.0.0.0 để máy khác trong mạng LAN mở được.
  const HOST = process.env.HOST || '127.0.0.1';
  const server = createServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Cổng ${PORT} đang được dùng (có thể RentMAPs đã chạy rồi: mở http://localhost:${PORT}).`);
      console.error(`Muốn chạy ở cổng khác: PORT=3200 npm start`);
    } else {
      console.error(err.message);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`RentMAPs đang chạy: http://localhost:${PORT}`);
    console.log('Nhấn Ctrl+C (hoặc đóng cửa sổ này) để tắt.');
  });
}

const { buildListingUrl, normalizeAd, normalizeRegions, normalizeWards, distance, poiCategory, normalizePois, overpassQuery, normalizeSeller } = api;
module.exports = { createServer, buildListingUrl, normalizeAd, normalizeRegions, normalizeWards, distance, poiCategory, normalizePois, overpassQuery, normalizeSeller };
