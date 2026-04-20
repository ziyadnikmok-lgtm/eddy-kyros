'use strict';

const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {
  startSession,
  stopSession,
  getSessionState,
  runTest,
  resetWatchState,
} = require('./redditPostService');

const ACCOUNTS_TEMPLATE_FILE = path.join(__dirname, 'accounts.json');
const ACCOUNTS_LOCAL_FILE = path.join(__dirname, 'accounts.local.json');
const APP_ICON_FILE = path.join(__dirname, 'assets', 'icon.png');

let win = null;

app.setName('Reddit Post Studio');

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

function getAccountsReadPath() {
  return fs.existsSync(ACCOUNTS_LOCAL_FILE) ? ACCOUNTS_LOCAL_FILE : ACCOUNTS_TEMPLATE_FILE;
}

function loadAccountsData() {
  const filePath = getAccountsReadPath();
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveAccountsData(data) {
  fs.writeFileSync(ACCOUNTS_LOCAL_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function createWindow() {
  const icon = fs.existsSync(APP_ICON_FILE) ? nativeImage.createFromPath(APP_ICON_FILE) : undefined;
  win = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#07070a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Reddit Post Studio',
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  if (fs.existsSync(APP_ICON_FILE)) {
    const icon = nativeImage.createFromPath(APP_ICON_FILE);
    if (!icon.isEmpty() && app.dock?.setIcon) app.dock.setIcon(icon);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  stopSession();
  app.quit();
});

ipcMain.handle('session:start', async (_event, config) => {
  try {
    startSession(config, (event) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('session:event', event);
      }
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('session:stop', () => {
  stopSession();
  return { ok: true };
});

ipcMain.handle('session:status', () => getSessionState());

ipcMain.handle('session:test', async (_event, config) => {
  try {
    runTest(config, (event) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('session:event', event);
      }
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('accounts:save', (_event, data) => {
  try {
    saveAccountsData(data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('accounts:load', () => {
  try {
    return { ok: true, data: loadAccountsData() };
  } catch {
    return { ok: true, data: null };
  }
});

ipcMain.handle('watch:reset', () => {
  try {
    resetWatchState();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('shell:openExternal', (_event, url) => {
  const { shell } = require('electron');
  shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
