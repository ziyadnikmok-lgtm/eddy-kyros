'use strict';

let accounts = [];
let targetProfiles = [];
let activeMode = 'scan';
let sessionRunning = false;
let sessionStartedAt = null;
let tickInterval = null;
let currentDrafts = 0;
let sessionMaxDrafts = 24;
let sessionMaxMs = 12 * 60 * 60 * 1000;
let accountsCollapsed = false;
let accountsCollapseTouched = false;
let targetsCollapsed = false;
let targetsCollapseTouched = false;

const DEFAULT_WATCH_SETTINGS = {
  watchMode: true,
  pollIntervalMinutes: 30,
  safeModeEnabled: true,
  riskGuardEnabled: true,
  threadLockEnabled: true,
  perTargetCooldownHours: 24,
  accountMaxRepliesPerHour: 2,
  accountMaxRepliesPerDay: 5,
  pauseOnFailureEnabled: true,
  consecutiveFailureLimit: 2,
  pauseMinutesOnFailure: 45,
  skipNsfw: true,
  sessionMaxReplies: 5,
  sessionDurationHours: 24,
  activeHoursEnabled: false,
  activeStartHour: 9,
  activeEndHour: 22,
  manualApprovalEnabled: true,
  imageReuseCooldownMinutes: 60,
};

const SAFE_TONES = [
  ['__default__', 'Use Global Tone'],
  ['sexy and engaging', '😈 Sexy and Engaging'],
  ['controversial sexy', '🔥 Controversial Sexy'],
  ['sexy and flirty', '💋 Sexy and Flirty'],
  ['engaging and friendly', 'Engaging and Friendly'],
  ['funny and witty', 'Funny and Witty'],
  ['professional and insightful', 'Professional and Insightful'],
  ['casual and relatable', 'Casual and Relatable'],
  ['enthusiastic and hype', 'Enthusiastic and Hype'],
  ['thoughtful and deep', 'Thoughtful and Deep'],
];

let _saveTimer = null;

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeToneValue(value) {
  const tone = String(value || '').trim();
  if (!tone || tone === '__default__') return '__default__';
  const valid = SAFE_TONES.some(([key]) => key === tone);
  return valid ? tone : 'engaging and friendly';
}

function normalizeAccountNameKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSubredditValue(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';

  const urlMatch = value.match(/https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/([A-Za-z0-9_]+)/i);
  if (urlMatch) return `r/${urlMatch[1]}`;

  const prefixedMatch = value.match(/^r\/([A-Za-z0-9_]+)$/i);
  if (prefixedMatch) return `r/${prefixedMatch[1]}`;

  const plainMatch = value.match(/^([A-Za-z0-9_]+)$/);
  if (plainMatch) return `r/${plainMatch[1]}`;

  return value;
}

function getTargetIdentityKey(value) {
  return normalizeSubredditValue(value).toLowerCase();
}

function getActiveAccount() {
  return accounts.find((account) => account.active) || accounts[0] || null;
}

function findAccountById(id) {
  return accounts.find((account) => account.id === id) || null;
}

function findAccountByName(name) {
  const key = normalizeAccountNameKey(name);
  if (!key) return null;
  return accounts.find((account) => normalizeAccountNameKey(account.name) === key) || null;
}

function resolvePostingAccount(profile) {
  if (!profile || profile.postingAccountId === '__active__') return getActiveAccount();
  return findAccountById(profile.postingAccountId) || findAccountByName(profile.postingAccountName) || getActiveAccount();
}

function getStoredPostingAccountName(profile) {
  if (!profile || profile.postingAccountId === '__active__') return '';
  return resolvePostingAccount(profile)?.name || profile.postingAccountName || '';
}

function repairTargetProfileRouting() {
  if (!targetProfiles.length || !accounts.length) return 0;
  const activeAccount = getActiveAccount();
  const alternateAccount = accounts.length === 2
    ? accounts.find((account) => account.id !== activeAccount?.id) || null
    : null;
  let repaired = 0;

  targetProfiles = targetProfiles.map((profile) => {
    if (!profile) return profile;
    if (profile.postingAccountId === '__active__') return { ...profile, postingAccountName: '' };

    const matchedById = findAccountById(profile.postingAccountId);
    if (matchedById) return { ...profile, postingAccountName: matchedById.name };

    const matchedByName = findAccountByName(profile.postingAccountName);
    if (matchedByName) {
      repaired++;
      return { ...profile, postingAccountId: matchedByName.id, postingAccountName: matchedByName.name };
    }

    if (alternateAccount) {
      repaired++;
      return { ...profile, postingAccountId: alternateAccount.id, postingAccountName: alternateAccount.name };
    }

    repaired++;
    return { ...profile, postingAccountId: '__active__', postingAccountName: '' };
  });

  return repaired;
}

function getRouteSummaryRows() {
  const rows = [];
  const activeAccount = getActiveAccount();
  const nonEmptyTargets = targetProfiles.filter((profile) => String(profile.value || '').trim());
  const buckets = new Map();

  if (activeAccount) {
    buckets.set(activeAccount.id, {
      id: activeAccount.id,
      name: activeAccount.name,
      kind: 'active',
      count: 0,
      note: 'Fallback and active posting account plan',
    });
  }

  for (const account of accounts) {
    if (buckets.has(account.id)) continue;
    buckets.set(account.id, {
      id: account.id,
      name: account.name,
      kind: account.active ? 'active' : 'direct',
      count: 0,
      note: account.active ? 'Active posting account plan' : 'Direct subreddit routing',
    });
  }

  let activeFallbackCount = 0;
  for (const profile of nonEmptyTargets) {
    if (profile.postingAccountId === '__active__') {
      activeFallbackCount++;
      if (activeAccount && buckets.has(activeAccount.id)) buckets.get(activeAccount.id).count++;
      continue;
    }

    const resolved = resolvePostingAccount(profile);
    if (resolved && buckets.has(resolved.id)) buckets.get(resolved.id).count++;
  }

  for (const bucket of buckets.values()) {
    rows.push({
      ...bucket,
      note: bucket.kind === 'active' && activeFallbackCount
        ? `${activeFallbackCount} target(s) using Active Account fallback`
        : bucket.note,
    });
  }

  return rows;
}

function renderRouteSummary(repairedCount = 0) {
  const panel = document.getElementById('routeSummary');
  const note = document.getElementById('routeHealthNote');
  if (!panel || !note) return;

  const rows = getRouteSummaryRows().filter((row) => row.count > 0 || accounts.some((account) => account.id === row.id));
  if (!targetProfiles.some((profile) => String(profile.value || '').trim())) {
    panel.innerHTML = '<div class="route-summary-item"><div><span class="route-summary-name">No targets yet</span><span class="route-summary-note">Add subreddit targets and the planned posting routes will appear here.</span></div><span class="route-summary-count">0</span></div>';
  } else if (!rows.length) {
    panel.innerHTML = '<div class="route-summary-item"><div><span class="route-summary-name">Drafts will be unassigned</span><span class="route-summary-note">You can still generate drafts without account cookies. Add accounts later if you want planned routing.</span></div><span class="route-summary-count">0</span></div>';
  } else {
    panel.innerHTML = rows.map((row) => `
      <div class="route-summary-item">
        <div>
          <span class="route-summary-name">${esc(row.name)}</span>
          <span class="route-summary-note">${esc(row.note)}</span>
        </div>
        <span class="route-summary-count">${row.count}</span>
      </div>
    `).join('');
  }

  if (repairedCount > 0) {
    note.className = 'route-health warn';
    note.textContent = `Repaired ${repairedCount} stale route${repairedCount === 1 ? '' : 's'} to valid posting accounts.`;
  } else if (!accounts.length) {
    note.className = 'route-health';
    note.textContent = 'Draft mode does not require live Reddit login. Accounts stay here as an optional routing plan.';
  } else if (accounts.length <= 1) {
    note.className = 'route-health';
    note.textContent = 'Single-account plan is active. All drafts use your active account plan unless you add more accounts.';
  } else {
    note.className = 'route-health';
    note.textContent = 'Assign subreddit targets to accounts here and each draft will carry that account plan forward.';
  }
}

function syncQuickButtons() {
  const configs = [
    ['quickWatchToggle', document.getElementById('watchMode')?.checked, 'Continuous schedule'],
    ['quickSafeToggle', document.getElementById('safeModeEnabled')?.checked, 'Safe mode'],
    ['quickManualToggle', document.getElementById('manualApprovalEnabled')?.checked, 'Manual approval'],
    ['quickHoursToggle', document.getElementById('activeHoursEnabled')?.checked, 'Active hours'],
  ];

  configs.forEach(([id, enabled, label]) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.classList.toggle('active', !!enabled);
    button.title = `${label}: ${enabled ? 'On' : 'Off'}`;
  });
}

function toggleQuickSetting(id) {
  const input = document.getElementById(id);
  if (!input) return;
  input.checked = !input.checked;
  syncWatchUi();
  syncQuickButtons();
  scheduleSave();
}

function getSettingsSnapshot() {
  return {
    tone: document.getElementById('toneSelect').value,
    geminiKey: document.getElementById('geminiKey').value,
    contentPrompt: document.getElementById('contentPrompt').value,
    contentImageKey: document.getElementById('contentImageKey').value,
    targetPostUrl: document.getElementById('targetPostUrl').value,
    imageFolder: document.getElementById('imageFolder')?.value || '',
    targetPostPostingAccountId: document.getElementById('targetPostPostingAccount')?.value || '__active__',
    accountsCollapsed,
    accountsCollapseTouched,
    targetsCollapsed,
    targetsCollapseTouched,
    watchSettings: getWatchSettingsFromInputs(),
  };
}

function getNumInput(id, fallback) {
  const value = Number(document.getElementById(id).value);
  return Number.isFinite(value) ? value : fallback;
}

function getWatchSettingsFromInputs() {
  return {
    watchMode: document.getElementById('watchMode').checked,
    pollIntervalMinutes: Math.max(10, getNumInput('pollIntervalMinutes', DEFAULT_WATCH_SETTINGS.pollIntervalMinutes)),
    safeModeEnabled: document.getElementById('safeModeEnabled').checked,
    riskGuardEnabled: document.getElementById('riskGuardEnabled').checked,
    threadLockEnabled: document.getElementById('threadLockEnabled').checked,
    perTargetCooldownHours: Math.min(168, Math.max(24, getNumInput('perTargetCooldownHours', DEFAULT_WATCH_SETTINGS.perTargetCooldownHours))),
    accountMaxRepliesPerHour: Math.min(2, Math.max(0, getNumInput('accountMaxRepliesPerHour', DEFAULT_WATCH_SETTINGS.accountMaxRepliesPerHour))),
    accountMaxRepliesPerDay: Math.min(5, Math.max(0, getNumInput('accountMaxRepliesPerDay', DEFAULT_WATCH_SETTINGS.accountMaxRepliesPerDay))),
    pauseOnFailureEnabled: document.getElementById('pauseOnFailureEnabled').checked,
    consecutiveFailureLimit: Math.min(10, Math.max(1, getNumInput('consecutiveFailureLimit', DEFAULT_WATCH_SETTINGS.consecutiveFailureLimit))),
    pauseMinutesOnFailure: Math.min(240, Math.max(5, getNumInput('pauseMinutesOnFailure', DEFAULT_WATCH_SETTINGS.pauseMinutesOnFailure))),
    skipNsfw: document.getElementById('skipNsfw').checked,
    sessionMaxReplies: Math.min(5, Math.max(1, getNumInput('sessionMaxReplies', DEFAULT_WATCH_SETTINGS.sessionMaxReplies))),
    sessionDurationHours: Math.max(1, getNumInput('sessionDurationHours', DEFAULT_WATCH_SETTINGS.sessionDurationHours)),
    activeHoursEnabled: document.getElementById('activeHoursEnabled').checked,
    activeStartHour: Math.min(23, Math.max(0, getNumInput('activeStartHour', DEFAULT_WATCH_SETTINGS.activeStartHour))),
    activeEndHour: Math.min(23, Math.max(0, getNumInput('activeEndHour', DEFAULT_WATCH_SETTINGS.activeEndHour))),
    manualApprovalEnabled: document.getElementById('manualApprovalEnabled').checked,
    imageReuseCooldownMinutes: Math.min(1440, Math.max(60, getNumInput('imageReuseCooldownMinutes', DEFAULT_WATCH_SETTINGS.imageReuseCooldownMinutes))),
  };
}

function applyWatchSettings(settings = {}) {
  const merged = { ...DEFAULT_WATCH_SETTINGS, ...(settings || {}) };
  merged.pollIntervalMinutes = Math.max(10, Number(merged.pollIntervalMinutes) || DEFAULT_WATCH_SETTINGS.pollIntervalMinutes);
  merged.perTargetCooldownHours = Math.max(24, Number(merged.perTargetCooldownHours) || DEFAULT_WATCH_SETTINGS.perTargetCooldownHours);
  merged.accountMaxRepliesPerHour = Math.min(2, Math.max(0, Number(merged.accountMaxRepliesPerHour) || DEFAULT_WATCH_SETTINGS.accountMaxRepliesPerHour));
  merged.accountMaxRepliesPerDay = Math.min(5, Math.max(0, Number(merged.accountMaxRepliesPerDay) || DEFAULT_WATCH_SETTINGS.accountMaxRepliesPerDay));
  merged.sessionMaxReplies = Math.min(5, Math.max(1, Number(merged.sessionMaxReplies) || DEFAULT_WATCH_SETTINGS.sessionMaxReplies));
  merged.imageReuseCooldownMinutes = Math.max(60, Number(merged.imageReuseCooldownMinutes) || DEFAULT_WATCH_SETTINGS.imageReuseCooldownMinutes);
  document.getElementById('watchMode').checked = merged.watchMode !== false;
  document.getElementById('pollIntervalMinutes').value = merged.pollIntervalMinutes;
  document.getElementById('safeModeEnabled').checked = merged.safeModeEnabled !== false;
  document.getElementById('riskGuardEnabled').checked = merged.riskGuardEnabled !== false;
  document.getElementById('threadLockEnabled').checked = merged.threadLockEnabled !== false;
  document.getElementById('perTargetCooldownHours').value = merged.perTargetCooldownHours;
  document.getElementById('accountMaxRepliesPerHour').value = merged.accountMaxRepliesPerHour;
  document.getElementById('accountMaxRepliesPerDay').value = merged.accountMaxRepliesPerDay;
  document.getElementById('pauseOnFailureEnabled').checked = merged.pauseOnFailureEnabled !== false;
  document.getElementById('consecutiveFailureLimit').value = merged.consecutiveFailureLimit;
  document.getElementById('pauseMinutesOnFailure').value = merged.pauseMinutesOnFailure;
  document.getElementById('skipNsfw').checked = merged.skipNsfw !== false;
  document.getElementById('sessionMaxReplies').value = merged.sessionMaxReplies;
  document.getElementById('sessionDurationHours').value = merged.sessionDurationHours;
  document.getElementById('activeHoursEnabled').checked = !!merged.activeHoursEnabled;
  document.getElementById('activeStartHour').value = merged.activeStartHour;
  document.getElementById('activeEndHour').value = merged.activeEndHour;
  document.getElementById('manualApprovalEnabled').checked = merged.manualApprovalEnabled !== false;
  document.getElementById('imageReuseCooldownMinutes').value = merged.imageReuseCooldownMinutes;
  syncWatchUi();
  syncQuickButtons();
}

function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(doSave, 600);
}

async function doSave() {
  const cleanProfiles = getTargetProfilesForSave();
  const result = await window.redditBot.saveAccounts({
    accounts,
    targetAccounts: cleanProfiles.map((profile) => profile.value),
    targetProfiles: cleanProfiles,
    settings: getSettingsSnapshot(),
  });
  if (result.ok) showSavedFeedback();
}

async function manualSave() {
  clearTimeout(_saveTimer);
  await doSave();
}

function showSavedFeedback() {
  const btn = document.getElementById('saveBtnTitle');
  btn.textContent = 'Saved';
  btn.classList.add('saved');
  clearTimeout(btn._resetTimer);
  btn._resetTimer = setTimeout(() => {
    btn.textContent = 'Save';
    btn.classList.remove('saved');
  }, 1800);
}

function genId() {
  return Math.random().toString(36).slice(2, 9);
}

function makeTargetProfile(value = '', tone = '__default__', personaNotes = '', postingAccountId = '__active__', postingAccountName = '') {
  return {
    id: genId(),
    kind: 'subreddit',
    value: normalizeSubredditValue(value),
    tone: normalizeToneValue(tone),
    personaNotes,
    postingAccountId: postingAccountId || '__active__',
    postingAccountName: postingAccountName || '',
  };
}

function normalizeSavedTargetProfile(item) {
  if (typeof item === 'string') return makeTargetProfile(item);
  if (!item || typeof item !== 'object') return makeTargetProfile('');
  return makeTargetProfile(
    item.value ?? item.input ?? item.name ?? '',
    item.tone ?? '__default__',
    item.personaNotes ?? item.notes ?? '',
    item.postingAccountId ?? item.accountId ?? '__active__',
    item.postingAccountName ?? item.accountName ?? ''
  );
}

function getTargetProfilesForSave() {
  return targetProfiles.map((profile) => ({
    kind: 'subreddit',
    value: normalizeSubredditValue(profile.value),
    tone: normalizeToneValue(profile.tone),
    personaNotes: String(profile.personaNotes || '').trim(),
    postingAccountId: profile.postingAccountId || '__active__',
    postingAccountName: getStoredPostingAccountName(profile),
  }));
}

function getFilledTargetProfiles() {
  return targetProfiles.filter((profile) => String(profile.value || '').trim());
}

function toneOptionsHtml(selected) {
  const current = normalizeToneValue(selected);
  return SAFE_TONES.map(([value, label]) => `<option value="${value}"${current === value ? ' selected' : ''}>${label}</option>`).join('');
}

function accountOptionsHtml(selected) {
  const current = selected || '__active__';
  const base = [`<option value="__active__"${current === '__active__' ? ' selected' : ''}>Use Active Account</option>`];
  for (const account of accounts) {
    const label = `${account.name}${account.active ? ' (Active)' : ''}`;
    base.push(`<option value="${esc(account.id)}"${current === account.id ? ' selected' : ''}>${esc(label)}</option>`);
  }
  return base.join('');
}

function renderTargetPostAccountSelect(selected) {
  const select = document.getElementById('targetPostPostingAccount');
  if (!select) return;
  const current = selected || select.value || '__active__';
  select.innerHTML = accountOptionsHtml(current);
  if (![...select.options].some((option) => option.value === current)) select.value = '__active__';
}

function addAccount() {
  accounts.push({ id: genId(), name: `Account ${accounts.length + 1}`, cookieRaw: '', active: accounts.length === 0 });
  renderAccounts();
  scheduleSave();
}

function removeAccount(id) {
  const wasActive = accounts.find((account) => account.id === id)?.active;
  accounts = accounts.filter((account) => account.id !== id);
  if (wasActive && accounts.length) accounts[0].active = true;
  renderAccounts();
  scheduleSave();
}

function setActiveAccount(id) {
  accounts.forEach((account) => { account.active = account.id === id; });
  renderAccounts();
  scheduleSave();
}

function updateAccountField(id, field, value) {
  const account = accounts.find((item) => item.id === id);
  if (!account) return;
  account[field] = value;
  scheduleSave();
}

function syncAccountsCollapsedUi() {
  const toggleBtn = document.getElementById('accountsToggleBtn');
  const mirrorBtn = document.getElementById('accountsToggleMirrorBtn');
  const hint = document.getElementById('accountsHint');
  const buttonLabel = accountsCollapsed ? `Show Accounts (${accounts.length})` : 'Hide Accounts';
  if (toggleBtn) toggleBtn.textContent = buttonLabel;
  if (mirrorBtn) mirrorBtn.textContent = buttonLabel;
  if (hint) hint.classList.toggle('hidden', accountsCollapsed && accounts.length > 0);
}

function toggleAccountsCollapsed() {
  accountsCollapseTouched = true;
  accountsCollapsed = !accountsCollapsed;
  renderAccounts();
  scheduleSave();
}

function ensureSmartAccountsCollapse() {
  if (accountsCollapseTouched) return;
  if (accounts.length >= 25) accountsCollapsed = true;
}

function parseCookieInfo(raw) {
  const source = String(raw || '').trim();
  if (!source) return null;
  if (source.startsWith('[')) {
    try {
      const array = JSON.parse(source);
      if (Array.isArray(array) && array[0]?.name) {
        const hasSession = array.some((cookie) => cookie.name === 'reddit_session');
        return { count: array.length, hasSession };
      }
    } catch {}
  }
  if (source.includes('=')) {
    const count = source.split(/;|\n/).filter((part) => part.includes('=')).length;
    const hasSession = source.includes('reddit_session');
    return { count, hasSession };
  }
  return null;
}

function renderAccounts() {
  const list = document.getElementById('accountsList');
  list.innerHTML = '';
  ensureSmartAccountsCollapse();
  syncAccountsCollapsedUi();

  if (!accounts.length) {
    list.innerHTML = '<div class="hint">No accounts yet. Add an account if you want a posting plan attached to each draft.</div>';
    document.getElementById('accCountBadge').textContent = '0';
    renderRouteSummary();
    renderTargetPostAccountSelect();
    return;
  }

  if (accountsCollapsed) {
    const activeAccount = getActiveAccount();
    list.innerHTML = `
      <div class="route-summary-item">
        <div>
          <span class="route-summary-name">${accounts.length} account${accounts.length === 1 ? '' : 's'} hidden</span>
          <span class="route-summary-note">${activeAccount ? `Active account: ${esc(activeAccount.name)}` : 'Expand to view and edit accounts.'}</span>
        </div>
        <span class="route-summary-count">${accounts.length}</span>
      </div>
    `;
    document.getElementById('accCountBadge').textContent = accounts.length;
    renderTargetPostAccountSelect();
    renderRouteSummary();
    return;
  }

  accounts.forEach((account) => {
    const info = parseCookieInfo(account.cookieRaw);
    const statusHtml = info
      ? `<div class="cookie-status ok">${info.count} cookies parsed${info.hasSession ? ' · reddit_session found' : ''}</div>`
      : '<div class="cookie-status">Paste cookies as JSON or name=value pairs</div>';

    const div = document.createElement('div');
    div.dataset.accountId = account.id;
    div.className = `account-card${account.active ? ' active' : ''}`;
    div.innerHTML = `
      <div class="account-head">
        <div class="account-name-row">
          <span class="account-dot"></span>
          <input class="account-name-input" value="${esc(account.name)}" oninput="updateAccountField('${account.id}', 'name', this.value)" placeholder="Account name" />
        </div>
        <button class="remove-btn" onclick="removeAccount('${account.id}')" title="Remove account">x</button>
      </div>
      <textarea placeholder='[{"name":"reddit_session","value":"..."}, ...]&#10;&#10;Or paste: reddit_session=...; token=...'
        oninput="updateAccountField('${account.id}', 'cookieRaw', this.value); refreshCookieStatus('${account.id}', this.value)">${esc(account.cookieRaw)}</textarea>
      ${statusHtml}
      <div class="footer-row">
        <button class="btn btn-sm ${account.active ? 'btn-primary' : 'btn-ghost'}" onclick="setActiveAccount('${account.id}')">${account.active ? 'Active Account' : 'Use This'}</button>
        ${account.active ? '<span class="active-label">Default routing plan</span>' : ''}
      </div>
    `;
    list.appendChild(div);
  });

  document.getElementById('accCountBadge').textContent = accounts.length;
  const repairedCount = repairTargetProfileRouting();
  renderTargetAccounts(repairedCount);
  renderTargetPostAccountSelect();
  renderRouteSummary(repairedCount);
  if (repairedCount) scheduleSave();
}

function refreshCookieStatus(id, value) {
  const info = parseCookieInfo(value);
  const card = document.querySelector(`.account-card[data-account-id="${id}"]`);
  if (!card) return;
  const status = card.querySelector('.cookie-status');
  if (!status) return;
  if (!info) {
    status.textContent = 'Paste cookies as JSON or name=value pairs';
    status.className = 'cookie-status';
    return;
  }
  status.textContent = `${info.count} cookies parsed${info.hasSession ? ' · reddit_session found' : ''}`;
  status.className = 'cookie-status ok';
}

function addTargetAccount() {
  targetProfiles.push(makeTargetProfile(''));
  renderTargetAccounts();
  scheduleSave();
}

function removeTargetAccount(id) {
  targetProfiles = targetProfiles.filter((profile) => profile.id !== id);
  if (!targetProfiles.length) targetProfiles.push(makeTargetProfile(''));
  renderTargetAccounts();
  scheduleSave();
}

function updateTargetProfile(id, field, value) {
  const profile = targetProfiles.find((item) => item.id === id);
  if (!profile) return;
  if (field === 'tone') profile[field] = normalizeToneValue(value);
  else if (field === 'value') profile[field] = value;
  else profile[field] = value;

  if (field === 'postingAccountId') {
    profile.postingAccountName = value === '__active__' ? '' : (findAccountById(value)?.name || profile.postingAccountName || '');
  }

  renderRouteSummary();
  scheduleSave();
}

function extractSubredditFromLine(line) {
  const source = String(line || '').trim();
  if (!source) return '';

  const urlMatch = source.match(/https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/([A-Za-z0-9_]+)/i);
  if (urlMatch) return `r/${urlMatch[1]}`;

  const prefixedMatch = source.match(/\br\/([A-Za-z0-9_]+)\b/i);
  if (prefixedMatch) return `r/${prefixedMatch[1]}`;

  const cells = source.split(/\t|,/).map((part) => part.trim()).filter(Boolean);
  for (const cell of cells) {
    const cellUrl = cell.match(/https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/([A-Za-z0-9_]+)/i);
    if (cellUrl) return `r/${cellUrl[1]}`;
    const cellPrefixed = cell.match(/^r\/([A-Za-z0-9_]+)$/i);
    if (cellPrefixed) return `r/${cellPrefixed[1]}`;
  }

  const plain = cells[0] || source;
  if (/^[A-Za-z0-9_]+$/.test(plain)) return `r/${plain}`;
  return '';
}

function buildImportedTargets(rawText, options = {}) {
  const lines = String(rawText || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const parsedTargets = [];
  const seen = new Set();
  const ignoreProfileId = options.ignoreProfileId || null;

  for (const profile of targetProfiles) {
    if (!profile || profile.id === ignoreProfileId) continue;
    const existingValue = String(profile.value || '').trim();
    if (!existingValue) continue;
    seen.add(getTargetIdentityKey(existingValue));
  }

  for (const line of lines) {
    const value = extractSubredditFromLine(line);
    if (!value) continue;
    const key = getTargetIdentityKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    parsedTargets.push({ value });
  }

  return parsedTargets;
}

function importTargetsIntoProfile(profileId, parsedTargets) {
  if (!Array.isArray(parsedTargets) || !parsedTargets.length) return 0;

  const index = targetProfiles.findIndex((profile) => profile.id === profileId);
  if (index === -1) return 0;

  const template = targetProfiles[index];
  const first = parsedTargets[0];

  targetProfiles[index] = {
    ...template,
    value: normalizeSubredditValue(first.value),
  };

  const extras = parsedTargets.slice(1).map((item) => makeTargetProfile(
    item.value,
    template.tone,
    template.personaNotes,
    template.postingAccountId,
    template.postingAccountName
  ));

  if (extras.length) targetProfiles.splice(index + 1, 0, ...extras);

  renderTargetAccounts();
  scheduleSave();
  appendLog('info', `Added ${parsedTargets.length} subreddit target${parsedTargets.length === 1 ? '' : 's'} from one paste.`);
  return parsedTargets.length;
}

function handleTargetPaste(event, id) {
  const text = event.clipboardData?.getData('text') || '';
  const lineCount = String(text).split('\n').map((line) => line.trim()).filter(Boolean).length;
  if (lineCount <= 1) return;

  const parsedTargets = buildImportedTargets(text, { ignoreProfileId: id });
  if (!parsedTargets.length) return;

  event.preventDefault();
  importTargetsIntoProfile(id, parsedTargets);
}

function syncTargetsCollapsedUi() {
  const toggleBtn = document.getElementById('targetsToggleBtn');
  const mirrorBtn = document.getElementById('targetsToggleMirrorBtn');
  const summary = document.getElementById('targetsCollapsedSummary');
  const filledTargets = getFilledTargetProfiles();
  const count = filledTargets.length;
  const label = targetsCollapsed ? `Show Targets (${count})` : 'Hide Targets';

  if (toggleBtn) toggleBtn.textContent = label;
  if (mirrorBtn) mirrorBtn.textContent = label;
  if (!summary) return;

  if (!targetsCollapsed) {
    summary.classList.add('hidden');
    summary.innerHTML = '';
    return;
  }

  const preview = filledTargets.slice(0, 3).map((profile) => esc(normalizeSubredditValue(profile.value))).join(' · ');
  summary.classList.remove('hidden');
  summary.innerHTML = `
    <div class="route-summary-item">
      <div>
        <span class="route-summary-name">${count} target${count === 1 ? '' : 's'} hidden</span>
        <span class="route-summary-note">${preview || 'Expand to view and edit your target subreddits.'}${count > 3 ? ' · …' : ''}</span>
      </div>
      <span class="route-summary-count">${count}</span>
    </div>
  `;
}

function toggleTargetsCollapsed() {
  targetsCollapseTouched = true;
  targetsCollapsed = !targetsCollapsed;
  renderTargetAccounts();
  scheduleSave();
}

function ensureSmartTargetsCollapse() {
  if (targetsCollapseTouched) return;
  if (getFilledTargetProfiles().length >= 15) targetsCollapsed = true;
}

function renderTargetAccounts(repairedCount = 0) {
  const list = document.getElementById('targetAccountsList');
  list.innerHTML = '';
  if (!targetProfiles.length) targetProfiles = [makeTargetProfile('')];
  ensureSmartTargetsCollapse();
  syncTargetsCollapsedUi();

  const scanControls = [
    ...document.querySelectorAll('#tc-scan > .section-actions'),
    document.getElementById('bulkImport')?.closest('.card'),
  ].filter(Boolean);

  scanControls.forEach((node) => {
    node.classList.toggle('hidden', targetsCollapsed);
  });

  if (targetsCollapsed) {
    list.classList.add('hidden');
    renderRouteSummary(repairedCount);
    return;
  }

  list.classList.remove('hidden');

  targetProfiles.forEach((profile) => {
    const resolvedRoute = resolvePostingAccount(profile);
    const routeLabel = profile.postingAccountId === '__active__'
      ? `Active · ${resolvedRoute?.name || 'Unassigned'}`
      : resolvedRoute?.name || profile.postingAccountName || 'Route missing';

    const card = document.createElement('div');
    card.className = 'target-card';
    card.innerHTML = `
      <div class="target-head">
        <div class="target-badges">
          <span class="tiny-badge route">${esc(routeLabel)}</span>
          ${profile.personaNotes ? '<span class="tiny-badge">Notes set</span>' : ''}
          ${repairedCount ? '<span class="tiny-badge warn">Route repaired</span>' : ''}
        </div>
        ${targetProfiles.length > 1 ? `<button class="remove-btn" onclick="removeTargetAccount('${profile.id}')" title="Remove target">x</button>` : ''}
      </div>
      <div class="inline-grid" style="margin-bottom:10px">
        <div>
          <label>Subreddit</label>
          <div class="sub-input-row">
            <input type="text" value="${esc(profile.value)}" placeholder="r/subreddit or subreddit URL"
              onpaste="handleTargetPaste(event, '${profile.id}')"
              oninput="updateTargetProfile('${profile.id}', 'value', this.value)" />
            <button class="sub-link-btn" onclick="openSubredditLink('${profile.id}')" title="Open on Reddit" ${profile.value ? '' : 'disabled'}>↗</button>
          </div>
        </div>
        <div>
          <label>Posting Account</label>
          <select onchange="updateTargetProfile('${profile.id}', 'postingAccountId', this.value)">
            ${accountOptionsHtml(profile.postingAccountId)}
          </select>
        </div>
      </div>
      <div class="inline-grid" style="margin-bottom:10px">
        <div>
          <label>Target Tone</label>
          <select onchange="updateTargetProfile('${profile.id}', 'tone', this.value)">
            ${toneOptionsHtml(profile.tone)}
          </select>
        </div>
        <div>
          <label>Subreddit Notes</label>
          <input type="text" value="${esc(profile.personaNotes || '')}" placeholder="Example: practical, curious, founder-heavy, discussion-first"
            oninput="updateTargetProfile('${profile.id}', 'personaNotes', this.value)" />
        </div>
      </div>
    `;
    list.appendChild(card);
  });

  renderRouteSummary(repairedCount);
}

function openSubredditLink(profileId) {
  const profile = targetProfiles.find((p) => p.id === profileId);
  if (!profile || !String(profile.value || '').trim()) return;
  const norm = normalizeSubredditValue(profile.value);
  if (!norm) return;
  const sub = norm.replace(/^r\//i, '');
  if (window.redditBot?.openExternal) window.redditBot.openExternal('https://www.reddit.com/r/' + encodeURIComponent(sub));
}

function balanceTargetRoutes() {
  const filledProfiles = targetProfiles.filter((profile) => String(profile.value || '').trim());
  const accountPool = accounts.filter((account) => account.name.trim());
  if (accountPool.length < 2 || filledProfiles.length < 2) {
    appendLog('warn', 'Add at least 2 posting accounts and 2 filled subreddit targets before balancing routes.');
    return;
  }

  filledProfiles.forEach((profile, index) => {
    const account = accountPool[index % accountPool.length];
    profile.postingAccountId = account.id;
    profile.postingAccountName = account.name;
  });
  renderTargetAccounts();
  renderTargetPostAccountSelect();
  renderRouteSummary();
  scheduleSave();
}

function importTargetLines() {
  const textarea = document.getElementById('bulkImport');
  const lines = String(textarea.value || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    appendLog('warn', 'Nothing to import yet. Paste one subreddit per line first.');
    return;
  }

  const parsedTargets = buildImportedTargets(textarea.value);
  const imported = parsedTargets.length;
  for (const item of parsedTargets) {
    targetProfiles.push(makeTargetProfile(item.value));
  }

  if (!targetProfiles.length) targetProfiles.push(makeTargetProfile(''));
  renderTargetAccounts();
  textarea.value = '';
  scheduleSave();
  appendLog('info', imported
    ? `Imported ${imported} subreddit target${imported === 1 ? '' : 's'}.`
    : 'Nothing new was imported because those subreddit targets already exist.'
  );
}

function switchTab(mode) {
  activeMode = mode;
  ['scan', 'target'].forEach((name) => {
    document.getElementById(`tab-${name}`).className = `tab-btn${name === mode ? ' active' : ''}`;
    document.getElementById(`tc-${name}`).className = `tab-content${name === mode ? ' active' : ''}`;
  });
  syncWatchUi();
}

function syncWatchUi() {
  const isScan = activeMode === 'scan';
  const watchCard = document.getElementById('watchSettingsCard');
  const watchBody = document.getElementById('watchSettingsBody');
  const watchEnabled = document.getElementById('watchMode').checked;
  const safeModeEnabled = document.getElementById('safeModeEnabled').checked;
  const pauseOnFailureEnabled = document.getElementById('pauseOnFailureEnabled').checked;
  const activeHoursEnabled = document.getElementById('activeHoursEnabled').checked;

  watchCard.classList.toggle('hidden', !isScan);
  watchBody.classList.toggle('hidden', !watchEnabled);
  document.getElementById('safeModeBody').classList.toggle('hidden', !(watchEnabled && safeModeEnabled));
  document.getElementById('pauseOnFailureBody').classList.toggle('hidden', !(watchEnabled && safeModeEnabled && pauseOnFailureEnabled));
  document.getElementById('activeHoursBody').classList.toggle('hidden', !(watchEnabled && activeHoursEnabled));
  document.getElementById('startBtn').textContent = isScan && watchEnabled ? 'Start Planner' : 'Start Session';
  syncQuickButtons();
}

function applySafeModePreset() {
  document.getElementById('safeModeEnabled').checked = true;
  document.getElementById('riskGuardEnabled').checked = true;
  document.getElementById('threadLockEnabled').checked = true;
  document.getElementById('pollIntervalMinutes').value = 30;
  document.getElementById('sessionMaxReplies').value = 5;
  document.getElementById('sessionDurationHours').value = 24;
  document.getElementById('perTargetCooldownHours').value = 24;
  document.getElementById('accountMaxRepliesPerHour').value = 2;
  document.getElementById('accountMaxRepliesPerDay').value = 5;
  document.getElementById('imageReuseCooldownMinutes').value = 60;
  document.getElementById('pauseOnFailureEnabled').checked = true;
  document.getElementById('consecutiveFailureLimit').value = 2;
  document.getElementById('pauseMinutesOnFailure').value = 45;
  document.getElementById('manualApprovalEnabled').checked = true;
  syncWatchUi();
  scheduleSave();
  appendLog('info', 'Safe schedule preset applied.');
}

function syncSessionLimitsFromConfig(config) {
  if (config?.targetPostUrl && config?.targetAccounts?.[0] === '__target__') {
    sessionMaxDrafts = 1;
    sessionMaxMs = 60 * 60 * 1000;
  } else {
    const watch = config?.watchSettings || DEFAULT_WATCH_SETTINGS;
    sessionMaxDrafts = watch.sessionMaxReplies || DEFAULT_WATCH_SETTINGS.sessionMaxReplies;
    sessionMaxMs = (watch.sessionDurationHours || DEFAULT_WATCH_SETTINGS.sessionDurationHours) * 60 * 60 * 1000;
  }
  document.getElementById('statMax').textContent = sessionMaxDrafts;
}

function syncSessionLimitsFromState(state) {
  sessionMaxDrafts = state?.maxReplies || DEFAULT_WATCH_SETTINGS.sessionMaxReplies;
  sessionMaxMs = state?.maxMs || (DEFAULT_WATCH_SETTINGS.sessionDurationHours * 60 * 60 * 1000);
  document.getElementById('statMax').textContent = sessionMaxDrafts;
}

function buildConfig() {
  const watchSettings = getWatchSettingsFromInputs();
  const base = {
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      cookieRaw: account.cookieRaw,
      active: !!account.active,
    })),
    cookieRaw: getActiveAccount()?.cookieRaw || '',
    geminiApiKey: document.getElementById('geminiKey').value.trim(),
    tone: document.getElementById('toneSelect').value,
    contentPrompt: document.getElementById('contentPrompt').value.trim(),
    contentImageKey: document.getElementById('contentImageKey').value.trim(),
    watchSettings,
  };

  if (activeMode === 'scan') {
    const cleanProfiles = getTargetProfilesForSave().filter((profile) => profile.value);
    if (!cleanProfiles.length) return { error: 'Add at least one subreddit target in Target Subreddits mode.' };
    return {
      ...base,
      targetProfiles: cleanProfiles,
      targetAccounts: cleanProfiles.map((profile) => profile.value),
      targetPostUrl: null,
    };
  }

  const target = normalizeSubredditValue(document.getElementById('targetPostUrl').value.trim());
  if (!target) return { error: 'Enter a subreddit like r/startups in Single Draft mode.' };
  return {
    ...base,
    targetAccounts: ['__target__'],
    targetPostUrl: target,
    targetPostPostingAccountId: document.getElementById('targetPostPostingAccount').value || '__active__',
  };
}

async function handleStart() {
  const config = buildConfig();
  if (config.error) {
    alert(config.error);
    return;
  }

  clearLog();
  clearDraftCards();
  syncSessionLimitsFromConfig(config);
  showSession(true);
  sessionStartedAt = Date.now();
  currentDrafts = 0;
  startTick();

  if (activeMode === 'target') {
    appendLog('info', 'Single Draft mode enabled - preparing one safe subreddit post draft.');
  } else if (config.watchSettings?.watchMode) {
    appendLog('info', `Planner enabled - preparing one safe draft every ${config.watchSettings.pollIntervalMinutes}m across ${config.targetProfiles.length} subreddit target(s).`);
    if (config.watchSettings.manualApprovalEnabled) {
      appendLog('info', 'Manual approval is on - each draft stays in the queue for you to submit yourself.');
    }
    if (config.watchSettings.activeHoursEnabled) {
      appendLog('info', `Active hours enabled - ${String(config.watchSettings.activeStartHour).padStart(2, '0')}:00 to ${String(config.watchSettings.activeEndHour).padStart(2, '0')}:00.`);
    }
  } else {
    appendLog('info', 'One-pass mode enabled - preparing one safe draft and stopping.');
  }

  const result = await window.redditBot.startSession(config);
  if (!result.ok) {
    appendLog('error', result.error || 'Failed to start planner.');
    showSession(false);
  }
}

async function handleStop() {
  await window.redditBot.stopSession();
  appendLog('info', 'Stop signal sent...');
}

async function handleClearWatchMemory() {
  if (!confirm('Reset draft memory and allow the planner to reuse older subreddit history again?')) return;
  const result = await window.redditBot.resetWatchMemory();
  if (result?.ok) appendLog('info', 'Draft memory cleared.');
  else appendLog('error', result?.error || 'Failed to clear draft memory.');
}

async function handleTest() {
  const config = buildConfig();
  if (config.error) {
    alert(config.error);
    return;
  }

  if (activeMode === 'scan' || !config.targetPostUrl) {
    const value = prompt('Paste a subreddit like r/startups to generate one draft:');
    const normalized = normalizeSubredditValue(value || '');
    if (!normalized) return;
    config.targetPostUrl = normalized;
    config.targetAccounts = ['__target__'];
  }

  appendLog('info', '--- SINGLE DRAFT TEST ---');

  const button = document.getElementById('testBtn');
  button.disabled = true;
  button.textContent = 'Testing...';
  setStatusPill('testing');

  const result = await window.redditBot.runTest(config);
  if (!result.ok) appendLog('error', result.error || 'Test failed.');

  button.disabled = false;
  button.textContent = 'Test Draft';
  if (!sessionRunning) setStatusPill('idle');
}

window.redditBot.onEvent((event) => {
  const { type, message, draft } = event;
  appendLog(type, message);

  if (type === 'draft') {
    if (event.count !== undefined) {
      currentDrafts = event.count;
      updateTick();
    }
    if (draft) addDraftCard(draft);
  }

  if (type === 'done' || type === 'stopped' || type === 'error') {
    sessionRunning = false;
    stopTick();
    showSession(false);
    setStatusPill(type === 'error' ? 'error' : type === 'stopped' ? 'idle' : 'done');
    const button = document.getElementById('testBtn');
    button.disabled = false;
    button.textContent = 'Test Draft';
  }
});

function makeActionButton(label, handler) {
  const button = document.createElement('button');
  button.className = 'btn btn-sm btn-ghost';
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

function addDraftCard(draft) {
  const panel = document.getElementById('replyLinksPanel');
  panel.classList.remove('hidden');

  const card = document.createElement('div');
  card.className = 'reply-link-card';

  const label = document.createElement('span');
  label.className = 'link-label';
  label.textContent = `Draft ${panel.querySelectorAll('.reply-link-card').length + 1} · ${draft.targetLabel || 'Subreddit'}${draft.postingAccountName ? ` · ${draft.postingAccountName}` : ''}`;

  const title = document.createElement('div');
  title.className = 'draft-title';
  title.textContent = draft.title || '';

  const body = document.createElement('div');
  body.className = 'draft-body';
  body.textContent = draft.body || '';

  const meta = document.createElement('div');
  meta.className = 'draft-meta';
  meta.textContent = `${draft.toneUsed || 'engaging and friendly'} · manual submit`;

  const actions = document.createElement('div');
  actions.className = 'section-actions';
  actions.appendChild(makeActionButton('Open Submit', () => window.redditBot.openExternal(draft.submitUrl)));
  actions.appendChild(makeActionButton('Copy Title', () => copyText(draft.title, 'title')));
  actions.appendChild(makeActionButton('Copy Body', () => copyText(draft.body, 'body')));
  actions.appendChild(makeActionButton('Copy Both', () => copyText(`${draft.title}\n\n${draft.body}`, 'draft')));

  card.appendChild(label);
  card.appendChild(title);
  card.appendChild(body);
  card.appendChild(meta);
  card.appendChild(actions);

  panel.appendChild(card);
  panel.scrollTop = panel.scrollHeight;
}

function clearDraftCards() {
  const panel = document.getElementById('replyLinksPanel');
  panel.innerHTML = '';
  panel.classList.add('hidden');
}

async function copyText(text, label = 'text') {
  try {
    await navigator.clipboard.writeText(String(text || ''));
    appendLog('info', `Copied ${label}.`);
  } catch {
    appendLog('warn', `Could not copy ${label}.`);
  }
}

function appendLog(type, message) {
  const scroll = document.getElementById('logScroll');
  const empty = scroll.querySelector('.log-empty');
  if (empty) empty.remove();

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = document.createElement('div');
  entry.className = `log-entry le-${type}`;
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${esc(message)}</span>`;
  scroll.appendChild(entry);
  scroll.scrollTop = scroll.scrollHeight;
}

function clearLog() {
  document.getElementById('logScroll').innerHTML = '<div class="log-empty">Waiting to start...</div>';
}

function startTick() {
  stopTick();
  tickInterval = setInterval(updateTick, 1000);
  updateTick();
}

function stopTick() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

function updateTick() {
  const ms = sessionStartedAt ? Date.now() - sessionStartedAt : 0;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  const maxDrafts = Math.max(1, sessionMaxDrafts || 1);
  const maxMs = Math.max(1, sessionMaxMs || 1);
  const maxMinutes = Math.max(1, Math.round(maxMs / 60000));

  document.getElementById('statReplies').textContent = currentDrafts;
  document.getElementById('statMax').textContent = maxDrafts;
  document.getElementById('statTime').textContent = `${min}:${String(s).padStart(2, '0')}`;
  document.getElementById('progRepliesText').textContent = `${currentDrafts} / ${maxDrafts}`;
  document.getElementById('progTimeText').textContent = `${min}m / ${maxMinutes}m`;
  document.getElementById('progRepliesFill').style.width = `${Math.min(100, (currentDrafts / maxDrafts) * 100)}%`;
  document.getElementById('progTimeFill').style.width = `${Math.min(100, (ms / maxMs) * 100)}%`;
}

function showSession(running, preserveProgress = false) {
  sessionRunning = running;
  document.getElementById('startBtn').classList.toggle('hidden', running);
  document.getElementById('testBtn').classList.toggle('hidden', running);
  document.getElementById('stopBtn').classList.toggle('hidden', !running);
  document.getElementById('statsSection').classList.toggle('hidden', !running);
  setStatusPill(running ? 'running' : 'idle');
  if (running && !preserveProgress) {
    currentDrafts = 0;
    updateTick();
  }
}

function setStatusPill(status) {
  const pill = document.getElementById('statusPill');
  pill.className = `pill ${status}`;
  const map = { idle: 'Idle', running: 'Running', testing: 'Testing', done: 'Done', error: 'Error' };
  document.getElementById('statusLabel').textContent = map[status] || status;
}

(async () => {
  applyWatchSettings(DEFAULT_WATCH_SETTINGS);
  const result = await window.redditBot.loadAccounts();

  if (result?.data) {
    const data = result.data;
    if (data.accounts?.length) {
      accounts = data.accounts;
      renderAccounts();
    } else {
      addAccount();
    }

    if (data.targetProfiles?.length) {
      targetProfiles = data.targetProfiles.map(normalizeSavedTargetProfile);
    } else if (data.targetAccounts?.length) {
      targetProfiles = data.targetAccounts.map((value) => makeTargetProfile(value));
    } else {
      targetProfiles = [makeTargetProfile('')];
    }

    if (data.settings) {
      const settings = data.settings;
      if (settings.tone) document.getElementById('toneSelect').value = normalizeToneValue(settings.tone);
      if (settings.geminiKey) document.getElementById('geminiKey').value = settings.geminiKey;
      if (settings.contentPrompt) document.getElementById('contentPrompt').value = settings.contentPrompt;
      if (settings.contentImageKey) document.getElementById('contentImageKey').value = settings.contentImageKey;
      if (settings.imageFolder) { const el = document.getElementById('imageFolder'); if (el) el.value = settings.imageFolder; }
      if (settings.targetPostUrl) document.getElementById('targetPostUrl').value = settings.targetPostUrl;
      accountsCollapsed = !!settings.accountsCollapsed;
      accountsCollapseTouched = !!settings.accountsCollapseTouched;
      targetsCollapsed = !!settings.targetsCollapsed;
      targetsCollapseTouched = !!settings.targetsCollapseTouched;
      renderTargetPostAccountSelect(settings.targetPostPostingAccountId || '__active__');
      applyWatchSettings(settings.watchSettings || DEFAULT_WATCH_SETTINGS);
    }

    renderAccounts();
    renderTargetAccounts();
    renderTargetPostAccountSelect(data.settings?.targetPostPostingAccountId || '__active__');

    appendLog('info', `Loaded ${accounts.length} saved account(s) and restored the last local settings.`);
  } else {
    addAccount();
    targetProfiles = [makeTargetProfile('')];
    renderTargetAccounts();
    renderTargetPostAccountSelect();
  }

  syncWatchUi();
  syncSessionLimitsFromConfig({
    targetAccounts: getTargetProfilesForSave().map((profile) => profile.value),
    targetPostUrl: document.getElementById('targetPostUrl').value,
    watchSettings: getWatchSettingsFromInputs(),
  });

  const state = await window.redditBot.getStatus();
  if (state?.status === 'running') {
    sessionRunning = true;
    sessionStartedAt = state.startedAt;
    currentDrafts = state.repliesCount || 0;
    syncSessionLimitsFromState(state);
    showSession(true, true);
    startTick();
    appendLog('info', 'Reconnected to a running planner session...');
  }
})();
