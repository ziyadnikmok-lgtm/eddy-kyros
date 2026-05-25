const state = {
  root: null,
  sessions: [],
  filtered: [],
  selectedId: '',
  selectedSession: null,
  selectedContent: '',
  query: '',
  source: 'all',
  loading: false,
  error: '',
};

const els = {
  rootLabel: document.getElementById('root-label'),
  search: document.getElementById('search'),
  sourceFilter: document.getElementById('source-filter'),
  reloadBtn: document.getElementById('reload-btn'),
  openFolderBtn: document.getElementById('open-folder-btn'),
  countLabel: document.getElementById('count-label'),
  statusLabel: document.getElementById('status-label'),
  sessionList: document.getElementById('session-list'),
  sessionSource: document.getElementById('session-source'),
  sessionTitle: document.getElementById('session-title'),
  sessionMeta: document.getElementById('session-meta'),
  sessionPreview: document.getElementById('session-preview'),
  transcript: document.getElementById('transcript'),
  copyTranscriptBtn: document.getElementById('copy-transcript-btn'),
  copyBriefBtn: document.getElementById('copy-brief-btn'),
  revealRawBtn: document.getElementById('reveal-raw-btn'),
};

function formatDate(value) {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function normalizeAbsolutePath(root, relPath = '') {
  if (!root) return relPath;
  const separator = root.includes('\\') ? '\\' : '/';
  const normalized = String(relPath).replace(/[\\/]+/g, separator);
  return `${root}${root.endsWith(separator) ? '' : separator}${normalized}`;
}

function sourceLabel(source) {
  const value = String(source || '');
  if (value.includes('Copilot')) return 'Copilot';
  if (value.includes('current')) return 'Current';
  if (value.includes('archived-old-visible-chats')) return 'Archive';
  if (value.includes('recovery-backup')) return 'Backup';
  if (value.includes('import-backup')) return 'Import';
  return value || 'Recovered';
}

function sessionSignature(session) {
  return [
    session.title,
    session.source,
    session.workspace,
    session.preview,
    session.messageCount,
  ].join(' ').toLowerCase();
}

function parseTranscript(content) {
  const lines = String(content || '').split(/\r?\n/);
  const messages = [];
  let inTranscript = false;
  let current = null;

  for (const line of lines) {
    if (line.trim() === '## Transcript') {
      inTranscript = true;
      continue;
    }
    if (!inTranscript) continue;

    if (line.startsWith('### ')) {
      if (current) messages.push(current);
      current = { role: line.slice(4).trim(), time: '', textLines: [] };
      continue;
    }

    if (!current) continue;

    if (!current.time && /^\d{4}-\d{2}-\d{2}T/.test(line.trim())) {
      current.time = line.trim();
      continue;
    }

    current.textLines.push(line);
  }

  if (current) messages.push(current);
  return messages
    .map((message) => ({
      role: message.role || 'Message',
      time: message.time || '',
      text: message.textLines.join('\n').trim(),
    }))
    .filter((message) => message.role || message.text);
}

function buildFilters() {
  const sources = new Set(['all']);
  for (const session of state.sessions) {
    for (const source of session.sources || [session.source]) {
      if (source) sources.add(source);
    }
  }

  els.sourceFilter.innerHTML = '';
  for (const source of sources) {
    const option = document.createElement('option');
    option.value = source;
    option.textContent = source === 'all' ? 'All sources' : sourceLabel(source);
    els.sourceFilter.appendChild(option);
  }
  els.sourceFilter.value = state.source;
}

function applyFilters() {
  const query = state.query.trim().toLowerCase();
  state.filtered = state.sessions.filter((session) => {
    const sourceMatch =
      state.source === 'all' ||
      session.source === state.source ||
      (session.sources || []).includes(state.source);
    if (!sourceMatch) return false;
    if (!query) return true;
    return sessionSignature(session).includes(query);
  });
  renderSessionList();
  els.countLabel.textContent = `${state.filtered.length} session${state.filtered.length === 1 ? '' : 's'}`;
  if (state.selectedId && !state.filtered.some((session) => session.id === state.selectedId)) {
    state.selectedId = '';
    state.selectedSession = null;
    state.selectedContent = '';
  }
  if (!state.selectedId && state.filtered.length > 0) {
    selectSession(state.filtered[0].id, { preserveScroll: true });
  }
  if (state.filtered.length === 0) {
    renderEmpty();
  }
}

function renderSessionList() {
  els.sessionList.innerHTML = '';
  if (state.filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'loading';
    empty.textContent = state.loading ? 'Loading sessions...' : 'No recovered chats match the current filters.';
    els.sessionList.appendChild(empty);
    return;
  }

  for (const session of state.filtered) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `session-item${session.id === state.selectedId ? ' active' : ''}`;
    button.addEventListener('click', () => selectSession(session.id));

    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = session.title || 'Untitled session';

    const meta = document.createElement('div');
    meta.className = 'session-meta';

    const sourcePill = document.createElement('span');
    sourcePill.className = 'pill';
    sourcePill.textContent = sourceLabel(session.source);
    meta.appendChild(sourcePill);

    const countPill = document.createElement('span');
    countPill.className = 'pill good';
    countPill.textContent = `${session.messageCount || 0} msgs`;
    meta.appendChild(countPill);

    if (session.workspace) {
      const workspacePill = document.createElement('span');
      workspacePill.className = 'pill';
      workspacePill.textContent = session.workspace.replace(/^.*[\\/]/, '');
      meta.appendChild(workspacePill);
    }

    const date = document.createElement('div');
    date.className = 'session-meta';
    date.textContent = formatDate(session.sessionTime || session.updatedAt);

    const preview = document.createElement('div');
    preview.className = 'session-preview';
    preview.textContent = session.preview || 'No preview available.';

    button.append(title, meta, date, preview);
    els.sessionList.appendChild(button);
  }
}

function renderEmpty() {
  els.sessionSource.textContent = 'No session selected';
  els.sessionTitle.textContent = 'Pick one chat on the left';
  els.sessionMeta.textContent = '';
  els.sessionPreview.textContent = '';
  els.transcript.className = 'transcript empty-state';
  els.transcript.textContent = state.loading
    ? 'Loading recovered chats...'
    : 'Select a recovered conversation to open the transcript.';
  els.copyTranscriptBtn.disabled = true;
  els.copyBriefBtn.disabled = true;
  els.revealRawBtn.disabled = true;
}

function renderSessionDetails() {
  const session = state.selectedSession;
  if (!session) {
    renderEmpty();
    return;
  }

  els.sessionSource.textContent = sourceLabel(session.source);
  els.sessionTitle.textContent = session.title || 'Untitled session';

  const metaParts = [];
  if (session.sessionTime) metaParts.push(formatDate(session.sessionTime));
  if (session.workspace) metaParts.push(`Workspace: ${session.workspace}`);
  if (session.messageCount != null) metaParts.push(`${session.messageCount} messages`);
  if (session.provider) metaParts.push(session.provider);
  els.sessionMeta.textContent = metaParts.join(' | ');
  els.sessionPreview.textContent = session.preview || 'No preview available.';

  const transcript = parseTranscript(state.selectedContent);
  els.transcript.className = 'transcript';
  els.transcript.innerHTML = '';

  if (!transcript.length) {
    const empty = document.createElement('div');
    empty.className = 'loading';
    empty.textContent = 'This session only has metadata, or the transcript body could not be parsed.';
    els.transcript.appendChild(empty);
  } else {
    for (const message of transcript) {
      const block = document.createElement('article');
      const role = message.role.toLowerCase().includes('user')
        ? 'user'
        : message.role.toLowerCase().includes('assistant')
          ? 'assistant'
          : 'system';
      block.className = `message ${role}`;

      const head = document.createElement('div');
      head.className = 'message-head';

      const roleLabel = document.createElement('span');
      roleLabel.className = 'message-role';
      roleLabel.textContent = message.role;

      head.appendChild(roleLabel);
      if (message.time) {
        const time = document.createElement('span');
        time.className = 'message-time';
        time.textContent = message.time;
        head.appendChild(time);
      }

      const body = document.createElement('pre');
      body.className = 'message-body';
      body.textContent = message.text || '';

      block.append(head, body);
      els.transcript.appendChild(block);
    }
  }

  els.copyTranscriptBtn.disabled = false;
  els.copyBriefBtn.disabled = false;
  els.revealRawBtn.disabled = false;
}

async function loadState() {
  state.loading = true;
  els.statusLabel.textContent = 'Loading';
  renderEmpty();

  const response = await window.recoveryAPI.getState();
  state.root = response.root || null;
  state.sessions = Array.isArray(response.sessions) ? response.sessions : [];
  state.filtered = [...state.sessions];
  els.rootLabel.textContent = state.root
    ? `Using ${state.root}`
    : 'No recovery folder found on Desktop';
  buildFilters();
  applyFilters();
  state.loading = false;
  els.statusLabel.textContent = state.root ? 'Ready' : 'No folder found';

  const saved = window.localStorage.getItem('recovery:selectedId');
  if (saved && state.filtered.some((session) => session.id === saved)) {
    await selectSession(saved, { preserveScroll: true });
  }
}

async function selectSession(id, { preserveScroll = false } = {}) {
  const session = state.filtered.find((entry) => entry.id === id) || state.sessions.find((entry) => entry.id === id);
  if (!session || !state.root) return;

  state.selectedId = id;
  renderSessionList();
  if (!preserveScroll) {
    window.localStorage.setItem('recovery:selectedId', id);
  }

  els.statusLabel.textContent = 'Loading transcript';
  const result = await window.recoveryAPI.getSession({ root: state.root, path: session.path });
  state.selectedSession = result.session;
  state.selectedContent = result.content || '';
  state.selectedId = result.session.id || id;
  window.localStorage.setItem('recovery:selectedId', state.selectedId);
  renderSessionDetails();
  renderSessionList();
  els.statusLabel.textContent = 'Ready';
}

function buildBrief() {
  if (!state.selectedSession) return '';
  const transcript = parseTranscript(state.selectedContent);
  const lines = [];
  lines.push(`Title: ${state.selectedSession.title || 'Untitled session'}`);
  lines.push(`Source: ${state.selectedSession.source || 'Unknown'}`);
  if (state.selectedSession.sessionTime) lines.push(`Session time: ${state.selectedSession.sessionTime}`);
  if (state.selectedSession.workspace) lines.push(`Workspace: ${state.selectedSession.workspace}`);
  lines.push(`Messages: ${state.selectedSession.messageCount || transcript.length}`);
  lines.push('');
  for (const message of transcript.slice(0, 6)) {
    lines.push(`### ${message.role}`);
    if (message.time) lines.push(message.time);
    lines.push(message.text);
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function copyText(value, label) {
  if (window.recoveryAPI?.copyText) {
    await window.recoveryAPI.copyText(value);
  } else {
    await navigator.clipboard.writeText(value);
  }
  els.statusLabel.textContent = `${label} copied`;
  window.setTimeout(() => {
    if (els.statusLabel.textContent === `${label} copied`) {
      els.statusLabel.textContent = 'Ready';
    }
  }, 1200);
}

els.search.addEventListener('input', (event) => {
  state.query = event.target.value;
  applyFilters();
});

els.sourceFilter.addEventListener('change', (event) => {
  state.source = event.target.value;
  applyFilters();
});

els.reloadBtn.addEventListener('click', async () => {
  await loadState();
});

els.openFolderBtn.addEventListener('click', async () => {
  if (!state.root) return;
  await window.recoveryAPI.openFolder(state.root);
});

els.copyTranscriptBtn.addEventListener('click', async () => {
  if (!state.selectedContent) return;
  await copyText(state.selectedContent, 'Transcript');
});

els.copyBriefBtn.addEventListener('click', async () => {
  if (!state.selectedSession) return;
  await copyText(buildBrief(), 'Brief');
});

els.revealRawBtn.addEventListener('click', async () => {
  if (!state.root || !state.selectedSession) return;
  const rawPath = state.selectedSession.rawFile || state.selectedSession.path;
  if (rawPath) {
    await window.recoveryAPI.revealFile(state.root, rawPath);
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== els.search) {
    event.preventDefault();
    els.search.focus();
  }
  if (event.key === 'Escape' && document.activeElement === els.search) {
    els.search.value = '';
    state.query = '';
    applyFilters();
  }
});

loadState().catch((error) => {
  state.loading = false;
  els.statusLabel.textContent = 'Error';
  els.rootLabel.textContent = 'Could not load recovered chats';
  els.sessionList.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'error';
  box.textContent = error?.message || 'Failed to load recovered chats.';
  els.sessionList.appendChild(box);
  renderEmpty();
});
