// electron/main.js
// Electron main process — creates the window, spawns the Express backend,
// and manages the app lifecycle.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const net = require('node:net');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const { findRecoveryRoot, listRecoverySessions, readRecoverySession } = require('./recovery-store');
const { validateKey, saveLicense, loadSavedLicense, clearLicense, publicLicenseInfo, getMachineFingerprint, isValidEmail, normalizeEmail } = require('./kyrosLicense');

// ── Error log file ──────────────────────────────────────────────────────
let _logStream = null;
function getLogStream() {
  if (_logStream) return _logStream;
  const logDir = app.getPath('logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'app.log');
  _logStream = fs.createWriteStream(logFile, { flags: 'a' });
  _logStream.write(`\n\n=== Session started ${new Date().toISOString()} ===\n`);
  console.log(`[electron] Log file: ${logFile}`);
  return _logStream;
}
function writeLog(line) {
  try { getLogStream().write(`[${new Date().toISOString()}] ${line}\n`); } catch {}
}
// Patch console to also write to log file
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
console.log = (...a) => { _origLog(...a); writeLog(a.join(' ')); };
console.error = (...a) => { _origErr(...a); writeLog('[ERROR] ' + a.join(' ')); };
process.on('uncaughtException', (e) => { writeLog('[UNCAUGHT] ' + e.stack); });
process.on('unhandledRejection', (r) => { writeLog('[UNHANDLED] ' + r); });

let mainWindow = null;
let recoveryWindow = null;
let serverProcess = null;
let serverPort = null;
let userDataPath = null;

const APP_VERSION = (() => {
  try { return require('../package.json').version || ''; } catch { return ''; }
})();
const APP_USAGE_ENDPOINT = process.env.KYROS_USAGE_ENDPOINT || 'https://kyros-studio.xyz/api/app-usage';
const OWNER_DEV_FLAG_FILE = path.join(__dirname, '..', '.owner-dev-unlock');
const OWNER_DEV_MODE = !app.isPackaged && (process.env.KYROS_OWNER_DEV === '1' || fs.existsSync(OWNER_DEV_FLAG_FILE));

function getOwnerDevLicense() {
  if (!OWNER_DEV_MODE) return null;
  return { valid: true, id: 'OWNER-DEV-LOCAL', plan: 'owner-dev', type: 'paid', maxSeats: 999, expiresAt: '2099-12-31T23:59:59.000Z', daysLeft: 9999, machineLocked: false, ownerDev: true };
}

function getValidLicense() {
  const owner = getOwnerDevLicense();
  if (owner) return owner;
  const lic = loadSavedLicense(app);
  return lic?.valid ? lic : null;
}

function reportAppUsage(event, extra = {}) {
  const license = getValidLicense();
  if (!license) return;
  const payload = JSON.stringify({
    licenseId: license.id,
    customerEmail: license.customerEmail || '',
    plan: license.plan,
    type: license.type,
    maxSeats: license.maxSeats,
    expiresAt: license.expiresAt,
    daysLeft: license.daysLeft,
    appVersion: APP_VERSION,
    machineFingerprint: getMachineFingerprint(),
    packaged: app.isPackaged,
    platform: process.platform,
    event,
    ...extra,
  });
  try {
    const url = new URL(APP_USAGE_ENDPOINT);
    const transport = url.protocol === 'http:' ? require('node:http') : require('node:https');
    const req = transport.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 3500,
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(payload);
    req.end();
  } catch {}
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

// ── Paths ───────────────────────────────────────────────────────────────

const serverEntry = path.join(__dirname, '..', 'server', 'index.js');
console.log(`[electron] main loaded. packaged=${app.isPackaged} execPath=${process.execPath}`);
console.log(`[electron] server entry=${serverEntry}`);

// Directories that must exist in userData for the server to work
const requiredDirs = ['data', 'uploads/generated', 'characters', 'temp'];

// ── Seed data on first launch ───────────────────────────────────────────

function ensureUserData() {
  console.log(`[electron] ensureUserData userDataPath=${userDataPath}`);
  for (const dir of requiredDirs) {
    const full = path.join(userDataPath, dir);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(full, { recursive: true });
    }
  }

  // Copy seed data from bundled resources (if packaged) or project root (if dev)
  const seedSource = app.isPackaged
    ? path.join(process.resourcesPath, 'seed-data')
    : path.join(__dirname, '..', 'server', 'data');

  const dataDir = path.join(userDataPath, 'data');

  // Copy .env if not present
  const envSource = app.isPackaged
    ? path.join(process.resourcesPath, '.env')
    : path.join(__dirname, '..', '.env');
  const envDest = path.join(userDataPath, '.env');
  if (!fs.existsSync(envDest) && fs.existsSync(envSource)) {
    fs.copyFileSync(envSource, envDest);
  }

  // Auto-generate ENCRYPTION_SECRET if missing (clean builds ship without one)
  if (fs.existsSync(envDest)) {
    const crypto = require('node:crypto');
    let envContent = fs.readFileSync(envDest, 'utf8');
    if (/^ENCRYPTION_SECRET=\s*$/m.test(envContent) || !envContent.includes('ENCRYPTION_SECRET=')) {
      const secret = crypto.randomBytes(32).toString('hex');
      envContent = envContent.replace(
        /^ENCRYPTION_SECRET=.*$/m,
        `ENCRYPTION_SECRET=${secret}`
      );
      if (!envContent.includes('ENCRYPTION_SECRET=')) {
        envContent += `\nENCRYPTION_SECRET=${secret}\n`;
      }
      fs.writeFileSync(envDest, envContent);
    }
  }

  // Copy seed JSON files that don't already exist (don't overwrite user data)
  if (fs.existsSync(seedSource)) {
    for (const file of fs.readdirSync(seedSource)) {
      const dest = path.join(dataDir, file);
      if (!fs.existsSync(dest)) {
        const src = path.join(seedSource, file);
        const stat = fs.statSync(src);
        if (stat.isFile()) {
          fs.copyFileSync(src, dest);
        }
      }
    }
  }

  // Copy characters on first launch (personal build only)
  if (app.isPackaged) {
    const charSeed = path.join(process.resourcesPath, 'seed-characters');
    const charDest = path.join(userDataPath, 'characters');
    if (fs.existsSync(charSeed)) {
      copyDirRecursive(charSeed, charDest);
    }

    // Copy gallery images on first launch (personal build only)
    const gallerySeed = path.join(process.resourcesPath, 'seed-gallery');
    const galleryDest = path.join(userDataPath, 'uploads', 'generated');
    if (fs.existsSync(gallerySeed)) {
      copyDirRecursive(gallerySeed, galleryDest);
    }
  }
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function sanitizeFileName(name = 'download') {
  return String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'download';
}

function timestampForFolder(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}-${min}-${ss}`;
}

function ensureUniqueDirectory(baseDir) {
  if (!fs.existsSync(baseDir)) return baseDir;
  let attempt = 2;
  while (true) {
    const candidate = `${baseDir} ${attempt}`;
    if (!fs.existsSync(candidate)) return candidate;
    attempt += 1;
  }
}

function ensureUniqueFilePath(directory, fileName) {
  const parsed = path.parse(fileName);
  let candidate = path.join(directory, fileName);
  if (!fs.existsSync(candidate)) return candidate;
  let attempt = 2;
  while (true) {
    candidate = path.join(directory, `${parsed.name} ${attempt}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    attempt += 1;
  }
}

ipcMain.handle('downloads:choose-directory', async (_event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: options.title || 'Choose where to save files',
    defaultPath: app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths?.[0]) return null;

  const folderName = sanitizeFileName(options.folderName || `Kyros Studio Library ${timestampForFolder()}`);
  const targetDir = ensureUniqueDirectory(path.join(result.filePaths[0], folderName));
  fs.mkdirSync(targetDir, { recursive: true });
  return targetDir;
});

ipcMain.handle('downloads:save-file', async (_event, payload = {}) => {
  const { directory, fileName, data } = payload;
  if (!directory || !fileName || data == null) {
    throw new Error('directory, fileName, and data are required');
  }

  fs.mkdirSync(directory, { recursive: true });
  const safeName = sanitizeFileName(fileName);
  const filePath = ensureUniqueFilePath(directory, safeName);
  const buffer = Buffer.isBuffer(data)
    ? data
    : ArrayBuffer.isView(data)
      ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.from(data);

  await fs.promises.writeFile(filePath, buffer);
  return { filePath, fileName: path.basename(filePath) };
});

ipcMain.handle('recovery:get-state', async () => {
  return listRecoverySessions();
});

ipcMain.handle('recovery:get-session', async (_event, payload = {}) => {
  const { root, path: relativePath } = payload || {};
  if (!relativePath) {
    throw new Error('path is required');
  }
  return readRecoverySession(root, relativePath);
});

ipcMain.handle('license:load', () => publicLicenseInfo(getOwnerDevLicense() || loadSavedLicense(app)));

ipcMain.handle('license:activate', (_event, payload) => {
  const keyStr = typeof payload === 'object' && payload ? payload.key : payload;
  const customerEmail = normalizeEmail(typeof payload === 'object' && payload ? payload.email : '');
  if (!isValidEmail(customerEmail)) {
    return { valid: false, reason: 'Enter a valid customer email before activating.' };
  }
  const result = validateKey(keyStr);
  if (result.valid) {
    result.customerEmail = customerEmail;
    saveLicense(app, result, customerEmail);
    reportAppUsage('license_activated', { licenseId: result.id, customerEmail, plan: result.plan, maxSeats: result.maxSeats });
  }
  return publicLicenseInfo(result);
});

ipcMain.handle('license:clear', () => {
  clearLicense(app);
  return { ok: true };
});

function createRecoveryWindow() {
  recoveryWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    title: 'Recovered Chats',
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'recovery-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  recoveryWindow.loadFile(path.join(__dirname, '..', 'recovery', 'index.html'));

  recoveryWindow.once('ready-to-show', () => {
    recoveryWindow.show();
    recoveryWindow.focus();
  });

  recoveryWindow.on('closed', () => {
    recoveryWindow = null;
  });
}

ipcMain.handle('recovery:open', async () => {
  if (recoveryWindow) {
    if (!recoveryWindow.isVisible()) recoveryWindow.show();
    recoveryWindow.focus();
    return true;
  }
  createRecoveryWindow();
  return true;
});

// ── Find free port ──────────────────────────────────────────────────────

// Use a fixed port so session cookies survive app restarts.
// If the port is already in use (e.g. two instances), fall back to random.
const PREFERRED_PORT = 18421;

function findFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(PREFERRED_PORT, '127.0.0.1', () => {
      srv.close(() => resolve(PREFERRED_PORT));
    });
    srv.on('error', () => {
      // Preferred port busy — pick a random available one
      const srv2 = net.createServer();
      srv2.listen(0, '127.0.0.1', () => {
        const { port } = srv2.address();
        srv2.close(() => resolve(port));
      });
      srv2.on('error', () => resolve(PREFERRED_PORT + 1));
    });
  });
}

// ── Wait for backend health check ───────────────────────────────────────

function waitForServer(port, timeoutMs = 90_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('Backend did not start in time'));
      }
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume(); // drain response to free socket
        if (res.statusCode === 200) return resolve();
        setTimeout(check, 300);
      });
      req.on('error', () => setTimeout(check, 300));
      req.setTimeout(5000, () => { req.destroy(); });
    }
    check();
  });
}

// ── Start backend ───────────────────────────────────────────────────────

async function startBackend() {
  serverPort = await findFreePort();
  console.log(`[electron] startBackend port=${serverPort}`);

  const envPath = path.join(userDataPath, '.env');
  const envExists = fs.existsSync(envPath);
  console.log(`[electron] envPath=${envPath} exists=${envExists}`);

  serverProcess = fork(serverEntry, [], {
    execPath: process.execPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(serverPort),
      HOST: '127.0.0.1',
      ELECTRON_USER_DATA: userDataPath,
      // Load .env from userData if it exists there
      ...(envExists ? { DOTENV_CONFIG_PATH: envPath } : {}),
    },
    stdio: 'pipe',
  });
  console.log('[electron] forked backend process');

  serverProcess.stdout?.on('data', (d) => { process.stdout.write(d); writeLog('[server] ' + d.toString().trim()); });
  serverProcess.stderr?.on('data', (d) => { process.stderr.write(d); writeLog('[server:err] ' + d.toString().trim()); });

  serverProcess.on('exit', (code) => {
    console.log(`[electron] Backend exited with code ${code}`);
    serverProcess = null;
    if (mainWindow && code !== 0 && code !== null) {
      const { dialog } = require('electron');
      dialog.showErrorBox('Backend Crashed', `The server process exited unexpectedly (code ${code}).`);
      app.quit();
    }
  });

  await waitForServer(serverPort);
  console.log(`[electron] Backend ready on port ${serverPort}`);
}

// ── Create window ───────────────────────────────────────────────────────

function createWindow() {
  console.log(`[electron] createWindow for port ${serverPort}`);
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: 'Kyros Studio',
    backgroundColor: '#09090b', // zinc-950 to match the dark theme
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    reportAppUsage('app_opened', { mode: 'local' });
    console.log('[electron] window shown');
  });
  mainWindow.webContents.on('did-finish-load', () => console.log('[electron] window finished load'));
  mainWindow.webContents.on('did-fail-load', (_event, code, desc) => console.error(`[electron] window failed load code=${code} desc=${desc}`));

  mainWindow.on('closed', () => {
    console.log('[electron] window closed');
    mainWindow = null;
  });
}

// ── App lifecycle ───────────────────────────────────────────────────────

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  console.log('[electron] app.whenReady');
  userDataPath = app.getPath('userData');

  // REMOTE_URL mode: skip local backend, open the hosted website directly.
  // Set REMOTE_URL in the userData .env or as an env var to enable.
  // Example:  REMOTE_URL=https://kyros.yourdomain.com
  const envPath = path.join(userDataPath, '.env');
  const forceLocalMode = process.env.KYROS_FORCE_LOCAL === '1';
  let remoteUrl = process.env.REMOTE_URL;
  if (!forceLocalMode && !remoteUrl && fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/^REMOTE_URL=(.+)$/m);
    if (match) remoteUrl = match[1].trim();
  }

  if (remoteUrl && !forceLocalMode) {
    console.log(`[electron] REMOTE_URL mode — loading ${remoteUrl}`);
    serverPort = null;
    mainWindow = new BrowserWindow({
      width: 1400, height: 900, minWidth: 1024, minHeight: 700,
      title: 'Kyros Studio',
      backgroundColor: '#09090b',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    mainWindow.loadURL(remoteUrl);
    mainWindow.webContents.on('did-finish-load', () => console.log('[electron] remote window loaded'));
    mainWindow.once('ready-to-show', () => reportAppUsage('app_opened', { mode: 'remote' }));
    mainWindow.on('closed', () => { mainWindow = null; });
    return;
  }

  if (forceLocalMode) {
    console.log('[electron] KYROS_FORCE_LOCAL=1 — skipping REMOTE_URL mode');
  }

  ensureUserData();
  await startBackend();
  createWindow();
}).catch((err) => {
  console.error('[electron] Fatal startup error:', err);
  const { dialog } = require('electron');
  dialog.showErrorBox('Startup Error', `Backend failed to start:\n${err.message}`);
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    const proc = serverProcess;
    serverProcess = null;
    proc.kill('SIGTERM');
    // Force-kill if graceful shutdown takes too long
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already exited */ }
    }, 5000).unref();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
    createWindow();
  }
});
