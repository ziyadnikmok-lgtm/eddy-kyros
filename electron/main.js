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
const APP_LICENSE_ENDPOINT = process.env.KYROS_LICENSE_ENDPOINT || 'https://kyros-studio.xyz/api/app-license/activate';
const OWNER_DEV_FLAG_FILE = path.join(__dirname, '..', '.owner-dev-unlock');
const OWNER_DEV_MODE = !app.isPackaged && (process.env.KYROS_OWNER_DEV === '1' || fs.existsSync(OWNER_DEV_FLAG_FILE));

function getOwnerDevLicense() {
  // Always return a valid unlimited license — no token screen needed
  return { valid: true, id: 'KYROS-UNLOCKED', plan: 'unlimited', type: 'paid', maxSeats: 999, expiresAt: 4936149853876, daysLeft: 36500, machineLocked: false, ownerDev: false, customerEmail: 'user@kyros.app' };
}

function getValidLicense() {
  return getOwnerDevLicense();
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

function postJson(urlString, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    try {
      const url = new URL(urlString);
      const transport = url.protocol === 'http:' ? require('node:http') : require('node:https');
      const req = transport.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: timeoutMs,
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            resolve({ statusCode: res.statusCode, body: parsed });
          } catch {
            reject(new Error('Activation server returned an invalid response.'));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Activation server timed out.')));
      req.write(payload);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
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

  // Auto-generate all required secrets if missing (clean builds ship without them)
  if (fs.existsSync(envDest)) {
    const crypto = require('node:crypto');
    let envContent = fs.readFileSync(envDest, 'utf8');
    let changed = false;

    const secretKeys = ['ENCRYPTION_SECRET', 'SESSION_SECRET', 'SERVER_ENCRYPTION_KEY'];
    for (const key of secretKeys) {
      const emptyPattern = new RegExp(`^${key}=\\s*$`, 'm');
      if (emptyPattern.test(envContent) || !envContent.includes(`${key}=`)) {
        const secret = crypto.randomBytes(32).toString('hex');
        if (envContent.includes(`${key}=`)) {
          envContent = envContent.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${secret}`);
        } else {
          envContent += `\n${key}=${secret}\n`;
        }
        changed = true;
      }
    }

    // Strip REMOTE_URL if present (leftover from old builds)
    if (/^REMOTE_URL=.+$/m.test(envContent)) {
      envContent = envContent.replace(/^REMOTE_URL=.*$/m, 'REMOTE_URL=');
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(envDest, envContent);
      console.log('[electron] Updated .env (generated secrets / cleared REMOTE_URL)');
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

ipcMain.handle('license:activate', async (_event, payload) => {
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

ipcMain.on('drag:start-files', (event, payload = {}) => {
  const { files, paths } = payload;
  const logPath = path.join(__dirname, '..', 'drag-debug.log');

  const logMessage = (msg) => {
    try {
      const timestamp = new Date().toISOString();
      fs.appendFileSync(logPath, `[${timestamp}] ${msg}\n`);
    } catch (e) {
      console.error('Failed to write to drag-debug.log', e);
    }
  };

  logMessage(`drag:start-files triggered. paths: ${JSON.stringify(paths)} | files count: ${files?.length || 0}`);

  let filePaths = [];

  if (Array.isArray(paths) && paths.length > 0) {
    for (const p of paths) {
      const resolvedPath = path.resolve(p);
      const exists = fs.existsSync(resolvedPath);
      logMessage(`Resolving path: "${p}" -> resolved: "${resolvedPath}" | exists: ${exists}`);
      if (exists) {
        filePaths.push(resolvedPath);
      }
    }
  } else if (Array.isArray(files) && files.length > 0) {
    const tempDir = path.join(app.getPath('temp'), 'kyros-drag-temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    // Clear previous drag-temp files
    try {
      for (const file of fs.readdirSync(tempDir)) {
        fs.unlinkSync(path.join(tempDir, file));
      }
    } catch {}

    for (const f of files) {
      const safeName = sanitizeFileName(f.name);
      const filePath = path.join(tempDir, safeName);
      const buffer = Buffer.from(f.base64, 'base64');
      fs.writeFileSync(filePath, buffer);
      filePaths.push(filePath);
      logMessage(`Created temp file: "${filePath}"`);
    }
  }

  logMessage(`Final filePaths to drag: ${JSON.stringify(filePaths)}`);

  if (filePaths.length === 0) {
    logMessage('Abort drag: filePaths is empty');
    return;
  }

  const tempDir = path.join(app.getPath('temp'), 'kyros-drag-temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const iconPath = path.join(tempDir, 'drag-icon.png');
  const transparentPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  fs.writeFileSync(iconPath, Buffer.from(transparentPngBase64, 'base64'));

  try {
    event.sender.startDrag({
      file: filePaths[0],
      files: filePaths,
      icon: iconPath
    });
    logMessage('startDrag successfully initiated');
  } catch (err) {
    logMessage(`startDrag failed with error: ${err.message}`);
  }
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
    show: true,
    title: 'Kyros Studio',
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const serverUrl = `http://127.0.0.1:${serverPort}`;
  let retryCount = 0;
  const maxRetries = 10;

  function loadApp() {
    console.log(`[electron] loading ${serverUrl} (attempt ${retryCount + 1})`);
    mainWindow.loadURL(serverUrl);
  }

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[electron] window finished load');
    mainWindow.focus();
    reportAppUsage('app_opened', { mode: 'local' });
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error(`[electron] window failed load code=${code} desc=${desc}`);
    retryCount++;
    if (retryCount < maxRetries) {
      console.log(`[electron] retrying in 2s (attempt ${retryCount + 1}/${maxRetries})`);
      setTimeout(loadApp, 2000);
    } else {
      console.error('[electron] max retries reached, showing error');
      mainWindow.loadURL(`data:text/html,<html><body style="background:#09090b;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Kyros Studio</h1><p>Backend server failed to start.</p><p style="color:#888">Check the logs or restart the app.</p></div></body></html>`);
    }
  });

  mainWindow.on('closed', () => {
    console.log('[electron] window closed');
    mainWindow = null;
  });

  loadApp();
}

// ── App lifecycle ───────────────────────────────────────────────────────

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  console.log('[electron] app.whenReady');
  userDataPath = app.getPath('userData');

  // Always run local backend — remote URL mode disabled

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
