// server/paths.js
// Centralized path resolver — works in both dev (node server/index.js) and
// packaged Electron (extraResources + userData).
//
// In Electron, main.js sets ELECTRON_USER_DATA to app.getPath('userData')
// so all writeable data goes to %APPDATA%/AI Content Studio/.

const path = require('node:path');

const isElectron = !!process.env.ELECTRON_USER_DATA;
const projectRoot = path.join(__dirname, '..');

// In dev:     data lives at server/data/, uploads at project/uploads/, etc.
// In Electron: everything under userData/ (%APPDATA%/AI Content Studio/)
const electronRoot = process.env.ELECTRON_USER_DATA;

const DATA_DIR = electronRoot ? path.join(electronRoot, 'data') : path.join(__dirname, 'data');
const UPLOADS_DIR = electronRoot ? path.join(electronRoot, 'uploads', 'generated') : path.join(projectRoot, 'uploads', 'generated');
const CHARACTERS_DIR = electronRoot ? path.join(electronRoot, 'characters') : path.join(projectRoot, 'characters');
const TEMP_DIR = electronRoot ? path.join(electronRoot, 'temp') : path.join(projectRoot, 'temp');
const BATCH_STORE = electronRoot ? path.join(electronRoot, 'data', 'batch-jobs.json') : path.join(projectRoot, 'data', 'batch-jobs.json');

// Read-only app code root (always relative to this file's location)
const SERVER_DIR = __dirname;
const CLIENT_DIST = path.join(projectRoot, 'client', 'dist');

module.exports = {
  isElectron,
  projectRoot,
  DATA_DIR,
  UPLOADS_DIR,
  CHARACTERS_DIR,
  TEMP_DIR,
  BATCH_STORE,
  SERVER_DIR,
  CLIENT_DIST,
};
