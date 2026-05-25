const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

function getDesktopRoot() {
  return path.join(os.homedir(), 'Desktop');
}

function rankSource(source = '') {
  const value = String(source).toLowerCase();
  if (value.includes('current')) return 0;
  if (value.includes('archived-old-visible-chats')) return 1;
  if (value.includes('recovery-backup')) return 2;
  if (value.includes('import-backup')) return 3;
  return 4;
}

function findRecoveryRoot(explicitRoot = process.env.KYROS_RECOVERY_ROOT) {
  if (explicitRoot && fs.existsSync(explicitRoot)) {
    return explicitRoot;
  }

  const desktop = getDesktopRoot();
  if (!fs.existsSync(desktop)) return null;

  const candidates = [];
  for (const entry of fs.readdirSync(desktop, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('recovered-codex-conversations-')) continue;
    const fullPath = path.join(desktop, entry.name);
    const stat = fs.statSync(fullPath);
    candidates.push({ path: fullPath, mtimeMs: stat.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path || null;
}

async function parseMarkdownSession(filePath) {
  const session = {
    title: path.basename(filePath, path.extname(filePath)),
    source: 'Unknown',
    sessionId: '',
    sessionTime: '',
    rawFile: '',
    workspace: '',
    provider: '',
    preview: '',
    messageCount: 0,
  };

  const previewLines = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let inTranscript = false;

  for await (const line of rl) {
    if (line.startsWith('# ')) {
      session.title = line.slice(2).trim() || session.title;
      continue;
    }

    if (line.startsWith('- Source: ')) {
      session.source = line.slice(10).trim() || session.source;
      continue;
    }
    if (line.startsWith('- Session ID: ')) {
      session.sessionId = line.slice(15).trim();
      continue;
    }
    if (line.startsWith('- Session time: ')) {
      session.sessionTime = line.slice(17).trim();
      continue;
    }
    if (line.startsWith('- Raw file: ')) {
      session.rawFile = line.slice(12).trim();
      continue;
    }
    if (line.startsWith('- Workspace: ')) {
      session.workspace = line.slice(13).trim();
      continue;
    }
    if (line.startsWith('- Provider: ')) {
      session.provider = line.slice(12).trim();
      continue;
    }

    if (line.trim() === '## Transcript') {
      inTranscript = true;
      continue;
    }
    if (!inTranscript) continue;

    if (line.startsWith('### ')) {
      session.messageCount += 1;
      if (previewLines.length < 10) {
        previewLines.push(line);
      }
      continue;
    }

    if (!line.trim()) {
      if (previewLines.length > 0 && previewLines[previewLines.length - 1] !== '') {
        previewLines.push('');
      }
      continue;
    }

    if (previewLines.length < 12) {
      previewLines.push(line);
    }
  }

  session.preview = previewLines.join('\n').trim();
  return session;
}

async function listRecoverySessions(root = findRecoveryRoot()) {
  if (!root) {
    return { root: null, sessions: [] };
  }

  const readableDir = path.join(root, 'readable-markdown');
  if (!fs.existsSync(readableDir)) {
    return { root, sessions: [] };
  }

  const grouped = new Map();
  const files = fs
    .readdirSync(readableDir)
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));

  for (const fileName of files) {
    const fullPath = path.join(readableDir, fileName);
    const session = await parseMarkdownSession(fullPath);
    const key = session.sessionId || fileName;
    const existing = grouped.get(key);
    const fileSourceRank = rankSource(session.source);
    const payload = {
      id: key,
      title: session.title,
      source: session.source,
      sources: [session.source],
      sessionId: session.sessionId,
      sessionTime: session.sessionTime,
      rawFile: session.rawFile,
      workspace: session.workspace,
      provider: session.provider,
      preview: session.preview,
      messageCount: session.messageCount,
      path: path.relative(root, fullPath).split(path.sep).join('/'),
      sourceRank: fileSourceRank,
      updatedAt: fs.statSync(fullPath).mtime.toISOString(),
    };

    if (!existing) {
      grouped.set(key, payload);
      continue;
    }

    existing.sources = Array.from(new Set([...(existing.sources || []), session.source]));
    existing.messageCount = Math.max(existing.messageCount || 0, session.messageCount || 0);
    if ((existing.sourceRank ?? 99) > fileSourceRank) {
      grouped.set(key, {
        ...existing,
        ...payload,
        sources: existing.sources,
      });
    }
  }

  const sessions = Array.from(grouped.values())
    .sort((a, b) => String(b.sessionTime || '').localeCompare(String(a.sessionTime || '')) || String(a.title).localeCompare(String(b.title)));

  return { root, sessions };
}

async function readRecoverySession(root, relativePath) {
  const recoveryRoot = root || findRecoveryRoot();
  if (!recoveryRoot) {
    throw new Error('No recovered chats folder was found.');
  }

  const absolutePath = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(recoveryRoot, relativePath);
  const content = fs.readFileSync(absolutePath, 'utf8');
  const session = await parseMarkdownSession(absolutePath);

  return {
    root: recoveryRoot,
    path: path.relative(recoveryRoot, absolutePath).split(path.sep).join('/'),
    content,
    session: {
      id: session.sessionId || path.basename(absolutePath, path.extname(absolutePath)),
      title: session.title,
      source: session.source,
      sessionId: session.sessionId,
      sessionTime: session.sessionTime,
      rawFile: session.rawFile,
      workspace: session.workspace,
      provider: session.provider,
      messageCount: session.messageCount,
      preview: session.preview,
      path: path.relative(recoveryRoot, absolutePath).split(path.sep).join('/'),
    },
  };
}

module.exports = {
  findRecoveryRoot,
  listRecoverySessions,
  readRecoverySession,
};
