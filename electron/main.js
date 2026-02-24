// electron/main.js
// Electron main process — creates the window, spawns the Express backend,
// and manages the app lifecycle.

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const net = require('node:net');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');

let mainWindow = null;
let serverProcess = null;
let serverPort = null;
let userDataPath = null;

// ── Paths ───────────────────────────────────────────────────────────────

const serverEntry = path.join(__dirname, '..', 'server', 'index.js');

// Directories that must exist in userData for the server to work
const requiredDirs = ['data', 'uploads/generated', 'characters', 'temp'];

// ── Seed data on first launch ───────────────────────────────────────────

function ensureUserData() {
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

// ── Find free port ──────────────────────────────────────────────────────

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ── Wait for backend health check ───────────────────────────────────────

function waitForServer(port, timeoutMs = 30_000) {
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

  const envPath = path.join(userDataPath, '.env');
  const envExists = fs.existsSync(envPath);

  serverProcess = fork(serverEntry, [], {
    env: {
      ...process.env,
      PORT: String(serverPort),
      HOST: '127.0.0.1',
      ELECTRON_USER_DATA: userDataPath,
      // Load .env from userData if it exists there
      ...(envExists ? { DOTENV_CONFIG_PATH: envPath } : {}),
    },
    stdio: 'pipe',
  });

  serverProcess.stdout?.on('data', (d) => process.stdout.write(d));
  serverProcess.stderr?.on('data', (d) => process.stderr.write(d));

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
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'AI Content Studio',
    backgroundColor: '#09090b', // zinc-950 to match the dark theme
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── App lifecycle ───────────────────────────────────────────────────────

app.whenReady().then(async () => {
  userDataPath = app.getPath('userData');
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
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
    createWindow();
  }
});
