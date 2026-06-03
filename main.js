const { app, BrowserWindow, ipcMain, dialog, Menu, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('no-sandbox');

let mainWindow;

const SUPPORTED_FORMATS = [
  'mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'opus', 'wma',
  'aiff', 'aif', 'ape', 'wv', 'mpc', 'tta', 'spx', 'amr',
  'mp4', 'webm', 'mkv', 'm4b', 'mp2', 'ac3', 'dts', 'ra',
  'mid', 'midi', 'mod', 'xm', 'it', 's3m', 'dsf', 'dff'
];

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const iconExists = fs.existsSync(iconPath);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1280,
    minHeight: 900,
    resizable: false,
    show: false,
    backgroundColor: '#0a0a0f',
    titleBarStyle: 'hiddenInset',
    acceptFirstMouse: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    },
    ...(iconExists && { icon: iconPath })
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.loadFile('index.html');

  // 네비게이션/다운로드 차단 (드래그 시 파일이 새 페이지로 열리는 것 방지)
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.session.on('will-download', (e) => e.preventDefault());

  // ── macOS 드래그앤드롭 fix ──
  // webContents.focus()로 firstResponder 확보 + 마우스 폴링으로 포커스 강제
  mainWindow.once('ready-to-show', () => {
    mainWindow.webContents.focus();
  });

  setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const cursor = screen.getCursorScreenPoint();
      const bounds = mainWindow.getBounds();
      const inWindow = cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width &&
                       cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height;
      if (inWindow && !mainWindow.isFocused()) {
        mainWindow.focus();
        mainWindow.webContents.focus();
      }
    } catch(e) {}
  }, 80);

  // macOS open-file 이벤트 (파인더에서 앱 아이콘으로 드롭할 때)
  app.on('open-file', (e, filePath) => {
    e.preventDefault();
    if (mainWindow) {
      const ext = path.extname(filePath).toLowerCase().slice(1);
      if (SUPPORTED_FORMATS.includes(ext)) {
        mainWindow.webContents.send('add-files', [filePath]);
      } else {
        const files = getMusicFiles(filePath);
        if (files.length > 0) mainWindow.webContents.send('add-files', files);
      }
    }
  });

  const menuTemplate = [
    {
      label: '파일',
      submenu: [
        {
          label: '음악 파일 열기...',
          accelerator: 'CmdOrCtrl+O',
          click: () => openFiles()
        },
        {
          label: '폴더 열기...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => openFolder()
        },
        { type: 'separator' },
        { label: '종료', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: '편집',
      submenu: [
        { label: '실행 취소', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '다시 실행', accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
        { type: 'separator' },
        { label: '복사', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '붙여넣기', accelerator: 'CmdOrCtrl+V', role: 'paste' }
      ]
    },
    {
      label: '보기',
      submenu: [
        { label: '개발자 도구', accelerator: 'CmdOrCtrl+Shift+I', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '실제 크기', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { label: '확대', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
        { label: '축소', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
}

function getMusicFiles(dirPath) {
  const results = [];
  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...getMusicFiles(fullPath));
        } else {
          const ext = path.extname(item).toLowerCase().slice(1);
          if (SUPPORTED_FORMATS.includes(ext)) {
            results.push(fullPath);
          }
        }
      } catch (e) {}
    }
  } catch (e) {}
  return results;
}

async function openFiles() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '음악 파일 선택',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '음악 파일', extensions: SUPPORTED_FORMATS },
      { name: '모든 파일', extensions: ['*'] }
    ]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    mainWindow.webContents.send('add-files', result.filePaths);
  }
}

async function openFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '폴더 선택',
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const files = getMusicFiles(result.filePaths[0]);
    if (files.length > 0) {
      mainWindow.webContents.send('add-files', files);
    }
  }
}

// 드래그 중 창 포커스
ipcMain.on('focus-window', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
});

ipcMain.handle('open-files', openFiles);
ipcMain.handle('open-folder', openFolder);

ipcMain.handle('get-music-files-from-folder', async (event, folderPath) => {
  return getMusicFiles(folderPath);
});

ipcMain.handle('get-file-info', async (event, filePath) => {
  try {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      name: path.basename(filePath),
      ext: path.extname(filePath).toLowerCase().slice(1),
      size: stat.size,
      exists: true
    };
  } catch (e) {
    return { exists: false };
  }
});

ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    return buffer.buffer;
  } catch (e) {
    return null;
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
