'use strict';

// Ứng dụng desktop: chạy server của công cụ ngay trong tiến trình Electron
// rồi mở cửa sổ trỏ vào http://127.0.0.1:<cổng>/__et/.

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, Menu, session, shell, systemPreferences, dialog, ipcMain } = require('electron');

// Dữ liệu phiên lưu trong thư mục dữ liệu của ứng dụng
// (macOS: ~/Library/Application Support/Heatmap/sessions).
process.env.DATA_DIR = process.env.DATA_DIR || app.getPath('userData');
// Bản đóng gói chỉ mang theo thư mục dist của WebGazer (xem build.extraResources trong package.json).
if (app.isPackaged) process.env.WEBGAZER_DIR = path.join(process.resourcesPath, 'webgazer');

const { createServer, TOOL_PREFIX, getSettings, settingsEvents, storageDir, sessionFilePaths, exportSession } = require(path.join(__dirname, '..', 'server.js'));

// Chuỗi của main process (menu, hộp thoại) theo ngôn ngữ trong Cài đặt.
const TEXT = {
  en: {
    view: 'View',
    home: 'Heatmap home',
    data: 'Data',
    openData: 'Open data folder',
    noCamera: 'Heatmap isn’t allowed to use the camera',
    noCameraDetail: 'Webcam eye tracking needs the camera. Open System Settings → Privacy & Security → Camera and turn on "Heatmap". Mouse, clicks and scrolling are still recorded without a camera.',
    startFailed: 'Heatmap couldn’t start',
    pickTitle: 'Choose a local web page',
    pickFilter: 'Web pages',
    folderTitle: 'Choose where Heatmap stores its data',
    saveTitle: 'Save session as',
    jsonFilter: 'Heatmap session (JSON)',
    csvFilter: 'Events table (CSV)',
  },
  vi: {
    view: 'Xem',
    home: 'Trang chủ Heatmap',
    data: 'Dữ liệu',
    openData: 'Mở thư mục dữ liệu',
    noCamera: 'Heatmap chưa được phép dùng camera',
    noCameraDetail: 'Eye tracking bằng webcam cần camera. Mở System Settings → Privacy & Security → Camera và bật cho "Heatmap". Không có camera vẫn ghi được chuột, click và cuộn trang.',
    startFailed: 'Không khởi động được Heatmap',
    pickTitle: 'Chọn trang web trên máy',
    pickFilter: 'Trang web',
    folderTitle: 'Chọn nơi Heatmap lưu dữ liệu',
    saveTitle: 'Lưu phiên thành',
    jsonFilter: 'Phiên Heatmap (JSON)',
    csvFilter: 'Bảng sự kiện (CSV)',
  },
};
const tx = (key) => (TEXT[getSettings().language] || TEXT.en)[key];

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
    title: 'Heatmap',
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

/** Chỉ trang của công cụ trong cửa sổ chính được gọi các IPC bên dưới. */
function fromTool(event) {
  return hasWindow() && event.sender === mainWindow.webContents && isOwnUrl(event.senderFrame && event.senderFrame.url);
}

// Cài đặt → Vị trí lưu trữ → "Chọn thư mục…"
ipcMain.handle('et:pick-folder', async (event, current) => {
  if (!fromTool(event)) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: tx('folderTitle'),
    defaultPath: typeof current === 'string' && current ? current : storageDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});

ipcMain.handle('et:open-folder', async (event) => {
  if (!fromTool(event)) return;
  await shell.openPath(storageDir());
});

// Danh sách phiên → "Mở file gốc": hiện file dữ liệu của phiên trong Finder.
ipcMain.handle('et:reveal-session', async (event, id) => {
  if (!fromTool(event)) return false;
  const files = sessionFilePaths(id);
  if (!files || !fs.existsSync(files.events)) return false;
  shell.showItemInFolder(files.events);
  return true;
});

// Danh sách phiên → "Lưu thành…": chọn nơi lưu và định dạng (JSON đầy đủ hoặc CSV sự kiện).
ipcMain.handle('et:save-session', async (event, id) => {
  if (!fromTool(event) || !sessionFilePaths(id)) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: tx('saveTitle'),
    defaultPath: path.join(app.getPath('documents'), `heatmap-session-${id}.json`),
    filters: [
      { name: tx('jsonFilter'), extensions: ['json'] },
      { name: tx('csvFilter'), extensions: ['csv'] },
    ],
  });
  if (result.canceled || !result.filePath) return null;
  const out = await exportSession(id, /\.csv$/i.test(result.filePath) ? 'csv' : 'json');
  if (!out) return null;
  await fs.promises.writeFile(result.filePath, out.body);
  return result.filePath;
});

// Nút "Chọn file…" ở trang chủ: chọn một file HTML trên máy để test.
ipcMain.handle('et:pick-html', async (event) => {
  if (!fromTool(event)) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: tx('pickTitle'),
    properties: ['openFile'],
    filters: [{ name: tx('pickFilter'), extensions: ['html', 'htm', 'xhtml'] }],
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
  // Eye tracking bị tắt trong Cài đặt → không cần hỏi quyền camera.
  if (process.platform !== 'darwin' || !getSettings().eyeTrackingEnabled) return;
  const status = systemPreferences.getMediaAccessStatus('camera');
  if (status === 'not-determined') {
    await systemPreferences.askForMediaAccess('camera');
  } else if (status === 'denied' || status === 'restricted') {
    dialog.showMessageBox({
      type: 'warning',
      message: tx('noCamera'),
      detail: tx('noCameraDetail'),
    });
  }
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: tx('view'),
      submenu: [
        { label: tx('home'), accelerator: 'CmdOrCtrl+Shift+H', click: () => {
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
      label: tx('data'),
      submenu: [
        { label: tx('openData'), click: () => shell.openPath(storageDir()) },
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
    console.log('Heatmap server:', baseUrl);
    setupPermissions();
    buildMenu();
    settingsEvents.on('change', buildMenu); // đổi ngôn ngữ → dựng lại menu
    await askCameraAccess();
    createWindow();

    app.on('activate', showMainWindow);
  }).catch((err) => {
    dialog.showErrorBox(tx('startFailed'), String(err && err.stack || err));
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
