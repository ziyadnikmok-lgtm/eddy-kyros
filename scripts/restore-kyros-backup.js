const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config();
require('../server/db');

const db = require('../server/db');
const { WEB_DATA_ROOT } = require('../server/paths');

const backupRoot = process.argv[2] || path.join(process.env.USERPROFILE || '', 'Desktop', 'Kyros_Data_Backup_Folder');
const backupUploads = path.join(backupRoot, 'uploads', 'generated');

function isValidPng(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const sig = Buffer.alloc(8);
    fs.readSync(fd, sig, 0, 8, 0);
    fs.closeSync(fd);
    return sig.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  } catch {
    return false;
  }
}

if (!fs.existsSync(backupUploads)) {
  console.error(`Missing backup uploads folder: ${backupUploads}`);
  process.exit(1);
}

const user =
  db.prepare('SELECT id, email FROM users WHERE is_owner = 1 ORDER BY created_at LIMIT 1').get()
  || db.prepare('SELECT id, email FROM users WHERE is_admin = 1 ORDER BY created_at LIMIT 1').get()
  || db.prepare('SELECT id, email FROM users ORDER BY created_at LIMIT 1').get();

if (!user) {
  console.error('No local user exists. Start the app once or set SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD in .env.');
  process.exit(1);
}

const userRoot = path.join(WEB_DATA_ROOT, user.id);
const uploadsDir = path.join(userRoot, 'uploads', 'generated');
const dataDir = path.join(userRoot, 'data');
const galleryPath = path.join(dataDir, 'gallery.json');

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

let gallery = [];
if (fs.existsSync(galleryPath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(galleryPath, 'utf8'));
    if (Array.isArray(parsed)) gallery = parsed;
  } catch {}
}

const existingNames = new Set(gallery.map((entry) => entry.filename).filter(Boolean));
const existingFiles = new Set(fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : []);

let copied = 0;
let skippedExisting = 0;
let skippedInvalid = 0;
let skippedSidecar = 0;

for (const dirent of fs.readdirSync(backupUploads, { withFileTypes: true })) {
  if (!dirent.isFile()) continue;
  if (dirent.name.startsWith('._')) {
    skippedSidecar += 1;
    continue;
  }
  if (path.extname(dirent.name).toLowerCase() !== '.png') continue;

  const sourcePath = path.join(backupUploads, dirent.name);
  if (!isValidPng(sourcePath)) {
    skippedInvalid += 1;
    continue;
  }

  const destPath = path.join(uploadsDir, dirent.name);
  if (!existingFiles.has(dirent.name)) {
    fs.copyFileSync(sourcePath, destPath);
    copied += 1;
  }

  if (existingNames.has(dirent.name)) {
    skippedExisting += 1;
    continue;
  }

  const stat = fs.statSync(destPath);
  const id = path.basename(dirent.name, path.extname(dirent.name));
  gallery.push({
    id,
    filename: dirent.name,
    mimeType: 'image/png',
    prompt: 'Restored from Kyros_Data_Backup_Folder',
    source: 'backup-restore',
    characterId: null,
    aspectRatio: null,
    seed: null,
    tags: ['restored'],
    personaMode: null,
    sessionId: null,
    fileSize: stat.size,
    isFavorite: false,
    createdAt: stat.mtime.toISOString(),
  });
  existingNames.add(dirent.name);
}

gallery.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
fs.writeFileSync(galleryPath, `${JSON.stringify(gallery, null, 2)}\n`);

console.log(JSON.stringify({
  user,
  backupUploads,
  uploadsDir,
  galleryPath,
  copied,
  galleryEntries: gallery.length,
  skippedExisting,
  skippedInvalid,
  skippedSidecar,
}, null, 2));
