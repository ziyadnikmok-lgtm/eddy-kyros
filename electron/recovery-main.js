const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { listRecoverySessions, readRecoverySession, findRecoveryRoot } = require('./recovery-store');

let windowRef = null;

ipcMain.handle('recovery:get-state', async () => listRecoverySessions());
ipcMain.handle('recovery:get-session', async (_event, payload = {}) => {
  const { root, path: sessionPath } = payload;
  if (!sessionPath) {
    throw new Error('path is required');
  }
  return readRecoverySession(root, sessionPath);
});
ipcMain.handle('recovery:root', async () => ({ root: findRecoveryRoot() }));

function createWindow() {
  windowRef = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1120,
    minHeight: 760,
    show: false,
    backgroundColor: '#07090d',
    title: 'Recovered Chats',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'recovery-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  windowRef.loadFile(path.join(__dirname, '..', 'recovery', 'index.html'));

  windowRef.once('ready-to-show', () => {
    windowRef.show();
    windowRef.focus();
  });

  windowRef.on('closed', () => {
    windowRef = null;
  });
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
