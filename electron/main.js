// electron/main.js
// Electron main process — creates the window, spawns the Express backend,
// and manages the app lifecycle.

const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
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

// Zero-dialog variant: hands back a ready-to-write subfolder under the OS Downloads directory
// with no file-picker prompt, for one-click "just save it" actions. folderName is sanitized and
// de-duped exactly like the picker path above.
ipcMain.handle('downloads:auto-directory', async (_event, options = {}) => {
  const folderName = sanitizeFileName(options.folderName || `Kyros Studio ${timestampForFolder()}`);
  const targetDir = ensureUniqueDirectory(path.join(app.getPath('downloads'), folderName));
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

// ── Create window ───────────────────────────────────────────────────────

const LOADING_HTML = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Kyros Studio</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #09090b; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    display: flex; align-items: center; justify-content: center; height: 100vh; flex-direction: column; }
  h1 { font-size: 2rem; margin-bottom: 1rem; background: linear-gradient(135deg, #a78bfa, #6366f1); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .spinner { width: 40px; height: 40px; border: 3px solid #27272a; border-top-color: #a78bfa; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 1.5rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #status { color: #71717a; font-size: 0.875rem; }
  #error { color: #ef4444; display: none; margin-top: 1rem; max-width: 500px; text-align: center; line-height: 1.5; }
</style></head>
<body>
  <div class="spinner" id="spinner"></div>
  <h1>Kyros Studio</h1>
  <div id="status">Starting server...</div>
  <div id="error"></div>
  <script>
    const port = new URLSearchParams(location.search).get('port');
    const logPath = new URLSearchParams(location.search).get('log') || '';
    let attempts = 0;
    const maxAttempts = 60;
    function check() {
      attempts++;
      document.getElementById('status').textContent = 'Starting server... (' + attempts + 's)';
      fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(3000) })
        .then(r => { if (r.ok) { location.href = 'http://127.0.0.1:' + port; } else { retry(); } })
        .catch(() => retry());
    }
    function retry() {
      if (attempts >= maxAttempts) {
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('status').textContent = 'Server failed to start';
        document.getElementById('error').style.display = 'block';
        document.getElementById('error').innerHTML =
          'The backend did not respond after ' + maxAttempts + ' seconds.<br>' +
          'Try restarting the app or deleting:<br><code style="color:#a78bfa">' + logPath + '</code>';
        return;
      }
      setTimeout(check, 1000);
    }
    setTimeout(check, 500);
  </script>
</body></html>`;

function createWindow() {
  console.log(`[electron] createWindow for port ${serverPort}`);

  // Open filling the right half of the screen, so the app sits beside an editor or a browser
  // without being dragged into place every launch.
  //
  // workArea, not bounds: it excludes the taskbar, so the window does not open with its bottom
  // edge hidden behind it.
  //
  // The PRIMARY display, deliberately — not the one under the cursor. Following the cursor put
  // the window on whichever screen the pointer happened to be resting on at launch, so clicking
  // a shortcut from the second monitor opened it over there. The main screen is where this is
  // meant to live; it should land in the same place every time regardless of the mouse.
  const active = screen.getPrimaryDisplay();
  const { x, y, width: areaW, height: areaH } = active.workArea;
  const halfW = Math.max(1024, Math.floor(areaW / 2));   // never below the minimum width

  mainWindow = new BrowserWindow({
    x: x + (areaW - halfW),   // right half
    y,
    width: halfW,
    height: areaH,
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

  // Show loading screen immediately — then it polls the backend and redirects when ready
  const logDir = userDataPath ? path.join(userDataPath, '..') : '';
  const loadingUrl = `data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`.replace(
    'LOADING_HTML', LOADING_HTML
  );
  // Use a temp file instead of data: URL so fetch() works (no CORS issues from data: origin)
  const tempHtml = path.join(app.getPath('temp'), 'kyros-loading.html');
  const htmlContent = LOADING_HTML.replace('</html>', '</html>');
  fs.writeFileSync(tempHtml, htmlContent);
  mainWindow.loadURL(`file://${tempHtml}?port=${serverPort}&log=${encodeURIComponent(logDir)}`);

  mainWindow.webContents.on('did-finish-load', () => {
    const url = mainWindow?.webContents?.getURL() || '';
    if (url.includes('127.0.0.1')) {
      console.log('[electron] App loaded successfully');
      mainWindow.focus();
      reportAppUsage('app_opened', { mode: 'local' });
    }
  });

  mainWindow.on('closed', () => {
    console.log('[electron] window closed');
    mainWindow = null;
  });
}

// ── App lifecycle ───────────────────────────────────────────────────────

/**
 * RELOAD THE WINDOW WHEN A NEW BUILD LANDS.
 *
 * Express serves client/dist from disk per request, so a rebuild is live the instant it finishes
 * -- but the already-booted renderer keeps the bundle it started with. That is the whole of "my
 * change did not take effect": on 2026-08-10 the app started at 11:16, a build finished at 11:50,
 * and the new chunk was not fetched until 11:54, when the window was reloaded by hand. Four
 * minutes of chasing a fix that had already shipped, repeated all day.
 *
 * index.html is the right file to watch: Vite rewrites it on every build because the hashed chunk
 * names inside it change. Watching client/src instead would fire on every keystroke.
 *
 * Debounced, because a build rewrites several files in quick succession and each one would
 * otherwise trigger its own reload. reloadIgnoringCache, so a stale HTTP cache entry cannot
 * survive the reload -- exactly the state that had to be cleared by hand today.
 *
 * Dev only. A packaged app's dist never changes underneath it, and a watcher there is a file
 * handle held for nothing.
 */
function watchBuildForReload() {
  if (app.isPackaged) return;
  const indexHtml = path.join(__dirname, '..', 'client', 'dist', 'index.html');
  if (!fs.existsSync(indexHtml)) return;
  let timer = null;
  try {
    fs.watch(indexHtml, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          console.log('[electron] new build detected - reloading the window');
          mainWindow.webContents.reloadIgnoringCache();
        }
      }, 400);
    });
    console.log('[electron] watching client/dist for rebuilds');
  } catch (err) {
    // A missing watcher costs a manual F5; it must never stop the app booting.
    console.warn('[electron] could not watch the build:', err.message);
  }
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  console.log('[electron] app.whenReady');
  userDataPath = app.getPath('userData');

  ensureUserData();

  // Show window FIRST with loading screen, then start backend
  // This guarantees the user always sees something immediately
  serverPort = await findFreePort();
  createWindow();
  watchBuildForReload();

  // Start backend in background — loading screen polls for health
  try {
    await startBackendProcess();
  } catch (err) {
    console.error('[electron] Backend start error:', err.message);
    // Loading screen will handle the timeout and show error
  }
}).catch((err) => {
  console.error('[electron] Fatal startup error:', err);
  const { dialog } = require('electron');
  dialog.showErrorBox('Startup Error', `Kyros Studio failed to start:\n${err.message}`);
  app.quit();
});

// startBackendProcess — fork the server but DON'T wait for health check
// (the loading screen handles that)
let lastServerError = '';
const serverErrorFile = path.join(app.getPath('temp'), 'kyros-server-error.txt');

/**
 * Give this install its own ENCRYPTION_SECRET and SESSION_SECRET.
 *
 * These used to ride along in a packaged build/.env, which meant every copy of the app shared
 * one set — so anyone holding a build could decrypt another install's stored API keys or forge
 * a session against the hosted instance. Generating them per machine ends that.
 *
 * Only ever ADDS missing keys. Rewriting an existing ENCRYPTION_SECRET would make every API key
 * already saved on this machine undecryptable, which would look like they had been wiped.
 */
function ensureLocalSecrets(envPath) {
  try {
    const crypto = require('node:crypto');
    const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const needed = ['ENCRYPTION_SECRET', 'SESSION_SECRET'].filter(
      (k) => !new RegExp(`^\\s*${k}\\s*=\\s*\\S`, 'm').test(existing),
    );
    if (!needed.length) return;

    const lines = needed.map((k) => `${k}=${crypto.randomBytes(32).toString('hex')}`);
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.appendFileSync(envPath, `${prefix}\n# Generated for this install on first launch — do not share.\n${lines.join('\n')}\n`);
    writeLog(`[electron] generated local secrets: ${needed.join(', ')}`);
  } catch (err) {
    writeLog(`[electron] could not generate local secrets: ${err.message}`);
  }
}

async function startBackendProcess() {
  console.log(`[electron] startBackendProcess port=${serverPort}`);

  const envPath = path.join(userDataPath, '.env');
  ensureLocalSecrets(envPath);          // before the fork: the server reads this file
  const envExists = fs.existsSync(envPath);
  console.log(`[electron] envPath=${envPath} exists=${envExists}`);

  // Clear old error file
  try { fs.unlinkSync(serverErrorFile); } catch {}

  serverProcess = fork(serverEntry, [], {
    execPath: process.execPath,
    /**
     * --watch in development, so a server route change takes effect without quitting the app.
     *
     * Routes are require()d once at boot, so editing server/routes/*.js did nothing until a full
     * restart -- and reloading the window never helped, because the window is not the server.
     * That is what "Route not found: POST /api/pinterest-feed/search" was on 2026-08-10: the file
     * existed, the process predated it.
     *
     * Never when packaged: --watch restarts on any file change, and a shipped app must not.
     */
    execArgv: app.isPackaged ? [] : ['--watch'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(serverPort),
      HOST: '127.0.0.1',
      ELECTRON_USER_DATA: userDataPath,
      ...(envExists ? { DOTENV_CONFIG_PATH: envPath } : {}),
    },
    stdio: 'pipe',
  });
  console.log('[electron] forked backend process');

  const stderrChunks = [];
  serverProcess.stdout?.on('data', (d) => { process.stdout.write(d); writeLog('[server] ' + d.toString().trim()); });
  serverProcess.stderr?.on('data', (d) => {
    process.stderr.write(d);
    const line = d.toString().trim();
    writeLog('[server:err] ' + line);
    stderrChunks.push(line);
    // Keep only last 20 lines
    if (stderrChunks.length > 20) stderrChunks.shift();
  });

  serverProcess.on('exit', (code) => {
    console.log(`[electron] Backend exited with code ${code}`);
    serverProcess = null;
    if (code !== 0 && code !== null) {
      lastServerError = stderrChunks.join('\n') || `Server exited with code ${code}`;
      try { fs.writeFileSync(serverErrorFile, lastServerError); } catch {}
      console.error(`[electron] Server crash error:\n${lastServerError}`);
      // Inject error directly into loading screen
      if (mainWindow && !mainWindow.isDestroyed()) {
        const safeError = lastServerError.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '<br>');
        mainWindow.webContents.executeJavaScript(`
          try {
            document.getElementById('spinner').style.display = 'none';
            document.getElementById('status').textContent = 'Server crashed (exit code ${code})';
            document.getElementById('error').style.display = 'block';
            document.getElementById('error').innerHTML = '<pre style="text-align:left;font-size:11px;color:#f87171;white-space:pre-wrap;max-height:300px;overflow:auto;background:#18181b;padding:12px;border-radius:8px;margin-top:8px">${safeError}</pre>';
          } catch(e) {}
        `).catch(() => {});
      }
    }
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    const proc = serverProcess;
    serverProcess = null;
    proc.kill('SIGTERM');
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
