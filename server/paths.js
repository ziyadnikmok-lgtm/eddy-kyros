const path = require('node:path');
const os = require('node:os');

const projectRoot = path.join(__dirname, '..');
const isTestRuntime = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
const testDataRoot = isTestRuntime
  ? path.join(os.tmpdir(), 'ai-content-studio-test-data', `pid-${process.pid}`)
  : null;
const userDataRoot = process.env.ELECTRON_USER_DATA || testDataRoot || null;

const DATA_DIR = userDataRoot ? path.join(userDataRoot, 'data') : path.join(__dirname, 'data');
const UPLOADS_DIR = userDataRoot ? path.join(userDataRoot, 'uploads', 'generated') : path.join(projectRoot, 'uploads', 'generated');
const CHARACTERS_DIR = userDataRoot ? path.join(userDataRoot, 'characters') : path.join(projectRoot, 'characters');
const TEMP_DIR = userDataRoot ? path.join(userDataRoot, 'temp') : path.join(projectRoot, 'temp');
const BATCH_STORE = userDataRoot ? path.join(userDataRoot, 'data', 'batch-jobs.json') : path.join(projectRoot, 'data', 'batch-jobs.json');
const SERVER_DIR = __dirname;
const CLIENT_DIST = path.join(projectRoot, 'client', 'dist');

module.exports = {
  projectRoot,
  DATA_DIR,
  UPLOADS_DIR,
  CHARACTERS_DIR,
  TEMP_DIR,
  BATCH_STORE,
  SERVER_DIR,
  CLIENT_DIST,
};
