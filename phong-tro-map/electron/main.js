'use strict';

// Ứng dụng desktop: chạy server của Phòng trọ Map ngay trong tiến trình Electron
// rồi mở cửa sổ trỏ vào http://127.0.0.1:<cổng>/.

const path = require('node:path');
const { app, BrowserWindow, Menu, shell, dialog, session, webFrameMain } = require('electron');

// Cache geocode, ảnh Street View và API key lưu trong thư mục dữ liệu của app
// (macOS: ~/Library/Application Support/Phong Tro Map).
process.env.DATA_DIR = process.env.DATA_DIR || app.getPath('userData');

// App tự gỡ lệnh cấm nhúng của trang tra cứu điểm ngập (xem allowFloodFrame), nên báo server là nhúng được.
process.env.PTM_DESKTOP = '1';

const { createServer, FLOOD_LOOKUP_URL, FLOOD_LOOKUP_TEXT } = require(path.join(__dirname, '..', 'server.js'));

// Cổng cố định để trình duyệt nhớ chế độ xem (localStorage theo cổng); bận thì lấy cổng trống bất kỳ.
const PREFERRED_PORT = 31070;

let baseUrl = null;
let mainWindow = null;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

async function startServer() {
  const server = createServer();
  try {
    return await listen(server, PREFERRED_PORT);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    return listen(server, 0);
  }
}

// ---------- tra cứu điểm ngập ----------

const FLOOD_HOST = new URL(FLOOD_LOOKUP_URL).hostname;

function isFloodHost(url) {
  try {
    const host = new URL(url).hostname;
    return host === FLOOD_HOST || host === 'vnexpress.net' || host.endsWith('.vnexpress.net');
  } catch {
    return false;
  }
}

// VnExpress có thể cấm nhúng trang vào trang khác (X-Frame-Options / CSP frame-ancestors).
// Chỉ với khung (iframe) của trang VnExpress trong popup tra cứu, bỏ hai header đó để hiện được.
function allowFloodFrame() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'subFrame' || !isFloodHost(details.url)) return callback({});
    const headers = {};
    for (const [name, values] of Object.entries(details.responseHeaders || {})) {
      const key = name.toLowerCase();
      if (key === 'x-frame-options') continue;
      headers[name] = key === 'content-security-policy'
        ? values.map((v) => v.replace(/frame-ancestors[^;]*;?/gi, ''))
        : values;
    }
    callback({ responseHeaders: headers });
  });
}

// Khi trang tra cứu tải xong trong khung, cuộn tới mục "Đường nơi bạn ở có nằm trong điểm ngập không".
// Nội dung tương tác có thể hiện chậm, nên thử lại vài lần.
function scrollFloodFrame(frame) {
  const script = `(() => {
    const want = ${JSON.stringify(FLOOD_LOOKUP_TEXT.toLowerCase())};
    let tries = 0;
    const find = () => {
      const els = document.querySelectorAll('h1, h2, h3, h4, h5, strong, b, p, div, span');
      for (const el of els) {
        if (el.children.length > 3) continue;
        if ((el.textContent || '').toLowerCase().includes(want)) {
          el.scrollIntoView({ block: 'start' });
          return true;
        }
      }
      return false;
    };
    const timer = setInterval(() => { if (find() || ++tries > 20) clearInterval(timer); }, 500);
    find();
  })();`;
  frame.executeJavaScript(script).catch(() => {});
}

function isOwnUrl(url) {
  return baseUrl !== null && url.startsWith(baseUrl);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 380,
    minHeight: 500,
    title: 'Phòng trọ Map',
    backgroundColor: '#f5f6f7',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Link tới Nhà Tốt, Google Maps, Zalo… mở bằng trình duyệt mặc định; số điện thoại (tel:)
  // mở bằng ứng dụng gọi điện của máy (FaceTime / iPhone trên macOS).
  const EXTERNAL = /^(https?|tel):/i;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL.test(url) && !isOwnUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (isOwnUrl(url)) return;
    e.preventDefault();
    if (EXTERNAL.test(url)) shell.openExternal(url);
  });
  mainWindow.webContents.on('did-frame-finish-load', (e, isMainFrame, processId, routingId) => {
    if (isMainFrame) return;
    const frame = webFrameMain.fromId(processId, routingId);
    if (frame && isFloodHost(frame.url)) scrollFloodFrame(frame);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(baseUrl);
}

function showMainWindow() {
  if (!baseUrl) return;
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' }, // cần cho Copy / Paste (vd. dán Google Maps API key)
    {
      label: 'Xem',
      submenu: [
        { label: 'Tải lại', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
        { label: 'Về trang đầu (xoá bộ lọc)', click: () => mainWindow?.loadURL(baseUrl) },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Cỡ chữ mặc định' },
        { role: 'zoomIn', label: 'Phóng to' },
        { role: 'zoomOut', label: 'Thu nhỏ' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Toàn màn hình' },
        { role: 'toggleDevTools', label: 'Công cụ nhà phát triển' },
      ],
    },
    {
      label: 'Dữ liệu',
      submenu: [
        { label: 'Mở thư mục dữ liệu', click: () => shell.openPath(process.env.DATA_DIR) },
        { label: 'Mở trong trình duyệt', click: () => baseUrl && shell.openExternal(baseUrl) },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  app.whenReady().then(async () => {
    try {
      const port = await startServer();
      baseUrl = `http://127.0.0.1:${port}/`;
    } catch (err) {
      dialog.showErrorBox('Không khởi động được Phòng trọ Map', String(err && err.message ? err.message : err));
      app.quit();
      return;
    }
    allowFloodFrame();
    buildMenu();
    createWindow();
    app.on('activate', showMainWindow);
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
