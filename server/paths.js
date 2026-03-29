const path = require('node:path');
const os = require('node:os');
const { getUserId } = require('./userContext');

const projectRoot = path.join(__dirname, '..');
const isTestRuntime = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
const WEB_DATA_ROOT = process.env.WEB_DATA_ROOT || path.join(projectRoot, 'userdata');
const SERVER_DIR = __dirname;
const CLIENT_DIST = path.join(projectRoot, 'client', 'dist');

function _getRoot() {
  if (isTestRuntime) {
    return path.join(os.tmpdir(), 'ai-content-studio-test-data', `pid-${process.pid}`);
  }
  if (process.env.ELECTRON_USER_DATA) {
    return process.env.ELECTRON_USER_DATA;
  }
  const userId = getUserId();
  if (userId) {
    return path.join(WEB_DATA_ROOT, userId);
  }
  // Fallback for startup / health checks (no user context)
  return path.join(projectRoot, 'server');
}

function getDataDir()       { return path.join(_getRoot(), 'data'); }
function getUploadsDir()    { return path.join(_getRoot(), 'uploads', 'generated'); }
function getCharactersDir() { return path.join(_getRoot(), 'characters'); }
function getTempDir()       { return path.join(projectRoot, 'temp'); }
function getBatchStore()    { return path.join(_getRoot(), 'data', 'batch-jobs.json'); }

module.exports = {
  projectRoot,
  SERVER_DIR,
  CLIENT_DIST,
  WEB_DATA_ROOT,
  getDataDir,
  getUploadsDir,
  getCharactersDir,
  getTempDir,
  getBatchStore,
  // Legacy getters — still work but computed dynamically per request
  get DATA_DIR()       { return getDataDir(); },
  get UPLOADS_DIR()    { return getUploadsDir(); },
  get CHARACTERS_DIR() { return getCharactersDir(); },
  get TEMP_DIR()       { return getTempDir(); },
  get BATCH_STORE()    { return getBatchStore(); },
};
