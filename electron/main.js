'use strict';

// Ứng dụng desktop: chạy server của công cụ ngay trong tiến trình Electron
// rồi mở cửa sổ trỏ vào http://127.0.0.1:<cổng>/__et/.

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, Menu, session, shell, systemPreferences, dialog, ipcMain } = require('electron');

// Dữ liệu phiên lưu trong thư mục dữ liệu của ứng dụng
// (macOS: ~/Library/Application Support/Eye Tracking Studio/sessions).
process.env.DATA_DIR = process.env.DATA_DIR || app.getPath('userData');
// Bản đóng gói chỉ mang theo thư mục dist của WebGazer (xem build.extraResources trong package.json).
if (app.isPackaged) process.env.WEBGAZER_DIR = path.join(process.resourcesPath, 'webgazer');

const { createServer, TOOL_PREFIX } = require(path.join(__dirname, '..', 'server.js'));

const BROWSE_PARTITION = 'persist:browse'; // cookie/đăng nhập của website test, tách khỏi công cụ
const GUEST_PRELOAD = path.join(__dirname, 'guest-preload.js');

// Website trong khung trình duyệt: http/https, hoặc file HTML trên máy (file://).
const BROWSABLE = /^(https?|file):/i;

let baseUrl = null;
let mainWindow = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    // Cổng 0 = hệ điều hành chọn cổng trống, tránh đụng ứng dụng khác.
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function isOwnUrl(url) {
  return typeof url === 'string' && url.startsWith(baseUrl);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Eye Tracking Studio',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'host-preload.js'),
      webviewTag: true,
    },
  });

  // Khung trình duyệt (<webview>) của màn hình theo dõi: luôn dùng preload ghi tương tác
  // của app, không bật Node cho website, chỉ cho mở http/https.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preloadURL;
    webPreferences.preload = GUEST_PRELOAD;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = false; // preload cần require() bộ ghi dùng chung
    params.partition = BROWSE_PARTITION;
    if (params.src && !BROWSABLE.test(params.src) && params.src !== 'about:blank') event.preventDefault();
  });

  // Website mở tab/cửa sổ mới → mở ngay trong khung trình duyệt để tiếp tục ghi.
  mainWindow.webContents.on('did-attach-webview', (event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (BROWSABLE.test(url)) contents.loadURL(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => {
      if (!BROWSABLE.test(url)) e.preventDefault();
    });
  });

  // Link mở tab mới (ví dụ "Mở trực tiếp trong tab mới") → mở bằng trình duyệt mặc định.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isOwnUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Cửa sổ chính chỉ được ở trong công cụ; link ngoài mở bằng trình duyệt.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isOwnUrl(url)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // macOS: đóng cửa sổ không thoát app → bỏ tham chiếu tới cửa sổ đã huỷ để lần mở lại tạo cửa sổ mới.
  const win = mainWindow;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  mainWindow.loadURL(baseUrl + TOOL_PREFIX + '/');
}

function hasWindow() {
  return !!mainWindow && !mainWindow.isDestroyed();
}

/** Mở lại app (bấm icon Dock, mở lần nữa từ Applications/Finder): đưa cửa sổ lên hoặc tạo mới. */
function showMainWindow() {
  if (!baseUrl) return; // server chưa sẵn sàng; cửa sổ sẽ được tạo khi khởi động xong
  if (!hasWindow()) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Nút "Chọn file…" ở trang chủ: chọn một file HTML trên máy để test.
ipcMain.handle('et:pick-html', async (event) => {
  if (!hasWindow() || event.sender !== mainWindow.webContents || !isOwnUrl(event.senderFrame && event.senderFrame.url)) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn trang web trên máy',
    properties: ['openFile'],
    filters: [{ name: 'Trang web', extensions: ['html', 'htm', 'xhtml'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return pathToFileURL(result.filePaths[0]).href;
});

function setupPermissions() {
  // Chỉ trang của công cụ được xin quyền camera (cho WebGazer); mọi quyền khác bị từ chối.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details.requestingUrl || wc.getURL();
    callback(permission === 'media' && isOwnUrl(origin) && (!details.mediaTypes || details.mediaTypes.every((t) => t === 'video')));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return permission === 'media' && isOwnUrl(requestingOrigin + '/');
  });
  // Website đang test không được xin camera, micro, vị trí, thông báo…
  const browse = session.fromPartition(BROWSE_PARTITION);
  browse.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  browse.setPermissionCheckHandler(() => false);
}

async function askCameraAccess() {
  if (process.platform !== 'darwin') return;
  const status = systemPreferences.getMediaAccessStatus('camera');
  if (status === 'not-determined') {
    await systemPreferences.askForMediaAccess('camera');
  } else if (status === 'denied' || status === 'restricted') {
    dialog.showMessageBox({
      type: 'warning',
      message: 'Ứng dụng chưa được phép dùng camera',
      detail: 'Eye tracking cần webcam. Mở System Settings → Privacy & Security → Camera và bật cho "Eye Tracking Studio". Bạn vẫn có thể ghi chuột, click và cuộn trang khi không có camera.',
    });
  }
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'Xem',
      submenu: [
        { label: 'Trang chủ công cụ', accelerator: 'CmdOrCtrl+Shift+H', click: () => {
          showMainWindow();
          if (hasWindow()) mainWindow.loadURL(baseUrl + TOOL_PREFIX + '/');
        } },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Dữ liệu',
      submenu: [
        { label: 'Mở thư mục dữ liệu', click: () => shell.openPath(path.join(process.env.DATA_DIR, 'sessions')) },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(async () => {
    const port = await startServer();
    baseUrl = `http://127.0.0.1:${port}`;
    console.log('Eye Tracking Studio server:', baseUrl);
    setupPermissions();
    buildMenu();
    await askCameraAccess();
    createWindow();

    app.on('activate', showMainWindow);
  }).catch((err) => {
    dialog.showErrorBox('Không khởi động được Eye Tracking Studio', String(err && err.stack || err));
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
