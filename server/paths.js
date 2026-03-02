const path = require('node:path');

const projectRoot = path.join(__dirname, '..');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(projectRoot, 'uploads', 'generated');
const CHARACTERS_DIR = path.join(projectRoot, 'characters');
const TEMP_DIR = path.join(projectRoot, 'temp');
const BATCH_STORE = path.join(projectRoot, 'data', 'batch-jobs.json');
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
