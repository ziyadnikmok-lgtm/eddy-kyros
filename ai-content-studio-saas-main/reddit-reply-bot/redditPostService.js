'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { normalizeTargetProfiles } = require('./redditFeedClient');

const WATCH_STATE_TEMPLATE_FILE = path.join(__dirname, 'watch-state.json');
const WATCH_STATE_LOCAL_FILE = path.join(__dirname, 'watch-state.local.json');
const WATCH_STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

const ALLOWED_TONES = new Set([
  'engaging and friendly',
  'funny and witty',
  'professional and insightful',
  'casual and relatable',
  'enthusiastic and hype',
  'thoughtful and deep',
  'sexy and engaging',
  'controversial sexy',
  'sexy and flirty',
]);

const UNSAFE_TARGET_RE = /\b(?:18|adult|anal|ass|bdsm|boobs?|breed|cum|dick|erotic|fetish|frott|fuck|gaysex|gonewild|hentai|hookup|incest|jerk|kink|loli|milf|nudes?|nsfw|onlyfans|orgy|panties|porn|pussy|rape|r4r|rule34|sex|sissy|slut|swingers?|teen|throat|twink|whore|yiff)\b/i;
const BLOCKED_PROMO_RE = /https?:\/\/|www\.|discord|telegram|whatsapp|cashapp|paypal|venmo|onlyfans|fansly|promo code|link in bio/i;
const BLOCKED_EXPLICIT_RE = /\b(?:adult content|anal|breed me|cum|cumming|deepthroat|dick|explicit|fuck me|gangbang|hardcore|horny|jerk off|nudes?|nsfw|orgy|porn|pussy|slut|throatfuck)\b/i;
const BLOCKED_MINOR_RE = /\b(?:child|children|high school|kid|kids|minor|schoolgirl|teen|underage|young girl|young boy)\b/i;

let currentSession = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeImageKey(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeMultiline(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getErrorMessage(err) {
  return normalizeWhitespace(err?.message || err || 'Unknown error');
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatHour(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function formatActiveHours(settings) {
  return `${formatHour(settings.activeStartHour)}-${formatHour(settings.activeEndHour)}`;
}

function trimText(text, max) {
  const clean = normalizeWhitespace(text);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function trimBody(text, max = 700) {
  const clean = normalizeMultiline(text);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function normalizeToneValue(value, fallback = 'engaging and friendly') {
  const tone = String(value || '').trim().toLowerCase();
  if (!tone || tone === '__default__') return null;
  return ALLOWED_TONES.has(tone) ? tone : fallback;
}

function normalizeAccountNameKey(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeBotAccounts(config = {}) {
  const source = Array.isArray(config.accounts) && config.accounts.length
    ? config.accounts
    : (config.cookieRaw ? [{ id: 'active', name: 'Active Account', cookieRaw: config.cookieRaw, active: true }] : []);
  const normalized = [];
  const seen = new Set();

  source.forEach((item, index) => {
    if (!item) return;
    const id = String(item.id || `account_${index + 1}`).trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    normalized.push({
      id,
      name: String(item.name || `Account ${index + 1}`).trim() || `Account ${index + 1}`,
      cookieRaw: String(item.cookieRaw || '').trim(),
      active: !!item.active,
    });
  });

  if (normalized.length && !normalized.some((item) => item.active)) normalized[0].active = true;
  return normalized;
}

function getDefaultBotAccount(botAccounts = []) {
  return botAccounts.find((item) => item.active) || botAccounts[0] || null;
}

function resolveTargetProfileAccounts(targetProfiles, botAccounts) {
  const defaultAccount = getDefaultBotAccount(botAccounts);

  return targetProfiles.map((profile) => {
    if (!botAccounts.length) {
      return {
        ...profile,
        postingAccountId: '__active__',
        postingAccountName: profile.postingAccountName || '',
      };
    }

    const desiredId = String(profile.postingAccountId || '__active__').trim() || '__active__';
    const desiredNameKey = normalizeAccountNameKey(profile.postingAccountName || '');

    if (desiredId !== '__active__') {
      const explicit = botAccounts.find((item) => item.id === desiredId);
      if (explicit) {
        return { ...profile, postingAccountId: explicit.id, postingAccountName: explicit.name };
      }
    }

    if (desiredNameKey) {
      const named = botAccounts.find((item) => normalizeAccountNameKey(item.name) === desiredNameKey);
      if (named) {
        return { ...profile, postingAccountId: named.id, postingAccountName: named.name };
      }
    }

    return {
      ...profile,
      postingAccountId: defaultAccount?.id || '__active__',
      postingAccountName: defaultAccount?.name || profile.postingAccountName || '',
    };
  });
}

function normalizeWatchSettings(raw = {}) {
  const pollIntervalMinutes = clamp(
    Math.round(toNumber(raw.pollIntervalMinutes ?? raw.postEveryMinutes, DEFAULT_WATCH_SETTINGS.pollIntervalMinutes)),
    10,
    180
  );
  const perTargetCooldownHours = clamp(
    Math.round(toNumber(raw.perTargetCooldownHours, DEFAULT_WATCH_SETTINGS.perTargetCooldownHours)),
    24,
    168
  );
  const accountMaxRepliesPerHour = clamp(
    Math.round(toNumber(raw.accountMaxRepliesPerHour ?? raw.accountMaxPostsPerHour, DEFAULT_WATCH_SETTINGS.accountMaxRepliesPerHour)),
    0,
    2
  );
  const accountMaxRepliesPerDay = clamp(
    Math.round(toNumber(raw.accountMaxRepliesPerDay ?? raw.accountMaxPostsPerDay, DEFAULT_WATCH_SETTINGS.accountMaxRepliesPerDay)),
    0,
    5
  );
  const consecutiveFailureLimit = clamp(
    Math.round(toNumber(raw.consecutiveFailureLimit, DEFAULT_WATCH_SETTINGS.consecutiveFailureLimit)),
    1,
    10
  );
  const pauseMinutesOnFailure = clamp(
    Math.round(toNumber(raw.pauseMinutesOnFailure, DEFAULT_WATCH_SETTINGS.pauseMinutesOnFailure)),
    5,
    240
  );
  const sessionMaxReplies = clamp(
    Math.round(toNumber(raw.sessionMaxReplies ?? raw.sessionMaxPosts, DEFAULT_WATCH_SETTINGS.sessionMaxReplies)),
    1,
    5
  );
  const sessionDurationHours = clamp(
    Math.round(toNumber(raw.sessionDurationHours, DEFAULT_WATCH_SETTINGS.sessionDurationHours)),
    1,
    72
  );
  const imageReuseCooldownMinutes = clamp(
    Math.round(toNumber(raw.imageReuseCooldownMinutes, DEFAULT_WATCH_SETTINGS.imageReuseCooldownMinutes)),
    60,
    1440
  );
  const activeStartHour = clamp(Math.round(toNumber(raw.activeStartHour, DEFAULT_WATCH_SETTINGS.activeStartHour)), 0, 23);
  const activeEndHour = clamp(Math.round(toNumber(raw.activeEndHour, DEFAULT_WATCH_SETTINGS.activeEndHour)), 0, 23);

  return {
    watchMode: toBoolean(raw.watchMode, DEFAULT_WATCH_SETTINGS.watchMode),
    pollIntervalMinutes,
    safeModeEnabled: toBoolean(raw.safeModeEnabled, DEFAULT_WATCH_SETTINGS.safeModeEnabled),
    riskGuardEnabled: toBoolean(raw.riskGuardEnabled, DEFAULT_WATCH_SETTINGS.riskGuardEnabled),
    threadLockEnabled: toBoolean(raw.threadLockEnabled, DEFAULT_WATCH_SETTINGS.threadLockEnabled),
    perTargetCooldownHours,
    accountMaxRepliesPerHour,
    accountMaxRepliesPerDay,
    pauseOnFailureEnabled: toBoolean(raw.pauseOnFailureEnabled, DEFAULT_WATCH_SETTINGS.pauseOnFailureEnabled),
    consecutiveFailureLimit,
    pauseMinutesOnFailure,
    skipNsfw: toBoolean(raw.skipNsfw, DEFAULT_WATCH_SETTINGS.skipNsfw),
    sessionMaxReplies,
    sessionDurationHours,
    activeHoursEnabled: toBoolean(raw.activeHoursEnabled, DEFAULT_WATCH_SETTINGS.activeHoursEnabled),
    activeStartHour,
    activeEndHour,
    manualApprovalEnabled: toBoolean(raw.manualApprovalEnabled, DEFAULT_WATCH_SETTINGS.manualApprovalEnabled),
    imageReuseCooldownMinutes,
    pollIntervalMs: pollIntervalMinutes * 60 * 1000,
    perTargetCooldownMs: perTargetCooldownHours * 60 * 60 * 1000,
    pauseMsOnFailure: pauseMinutesOnFailure * 60 * 1000,
    sessionMaxMs: sessionDurationHours * 60 * 60 * 1000,
    imageReuseCooldownMs: imageReuseCooldownMinutes * 60 * 1000,
  };
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeWriteJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function getWatchStateReadPath() {
  return fs.existsSync(WATCH_STATE_LOCAL_FILE) ? WATCH_STATE_LOCAL_FILE : WATCH_STATE_TEMPLATE_FILE;
}

function pruneWatchState(state) {
  const posts = state?.posts && typeof state.posts === 'object' ? state.posts : {};
  const cutoff = Date.now() - WATCH_STATE_RETENTION_MS;

  for (const [postId, record] of Object.entries(posts)) {
    const updatedAt = Date.parse(record?.updatedAt || record?.draftedAt || record?.createdAt || 0);
    if (updatedAt && updatedAt < cutoff) delete posts[postId];
  }

  const ordered = Object.entries(posts).sort((left, right) => {
    const leftTime = Date.parse(left[1]?.updatedAt || left[1]?.draftedAt || 0) || 0;
    const rightTime = Date.parse(right[1]?.updatedAt || right[1]?.draftedAt || 0) || 0;
    return rightTime - leftTime;
  });

  for (const [postId] of ordered.slice(2500)) delete posts[postId];
  return { posts };
}

function loadWatchState() {
  return pruneWatchState(safeReadJson(getWatchStateReadPath(), { posts: {} }));
}

function saveWatchState(state) {
  safeWriteJson(WATCH_STATE_LOCAL_FILE, pruneWatchState(state));
}

function resetWatchState() {
  saveWatchState({ posts: {} });
  return { ok: true };
}

function upsertWatchRecord(state, recordId, patch) {
  const now = new Date().toISOString();
  const existing = state.posts[recordId] || {};
  state.posts[recordId] = { ...existing, postId: recordId, createdAt: existing.createdAt || now, updatedAt: now, ...patch };
  return state.posts[recordId];
}

function toTimestamp(value) {
  const timestamp = Date.parse(value || 0);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getDraftedWatchRecords(state) {
  return Object.values(state?.posts || {})
    .filter((record) => record?.status === 'drafted' && (record?.title || record?.body))
    .sort((left, right) => toTimestamp(right.draftedAt || right.updatedAt) - toTimestamp(left.draftedAt || left.updatedAt));
}

function getLatestDraftForTarget(state, targetKey) {
  const normalizedKey = String(targetKey || '').trim().toLowerCase();
  if (!normalizedKey) return null;
  return getDraftedWatchRecords(state).find((record) => String(record.targetKey || '').trim().toLowerCase() === normalizedKey) || null;
}

function getRecentDraftRecordsForAccount(state, accountId, windowMs) {
  if (!accountId || !windowMs) return [];
  const now = Date.now();
  return getDraftedWatchRecords(state)
    .filter((record) => String(record.postingAccountId || '') === String(accountId))
    .filter((record) => {
      const draftedAt = toTimestamp(record.draftedAt || record.updatedAt);
      return draftedAt && now - draftedAt < windowMs;
    })
    .sort((left, right) => toTimestamp(left.draftedAt || left.updatedAt) - toTimestamp(right.draftedAt || right.updatedAt));
}

function getRecentDraftTexts(state, limit = 12) {
  return getDraftedWatchRecords(state)
    .slice(0, limit)
    .map((record) => normalizeWhitespace([record.title, record.body].filter(Boolean).join(' ')))
    .filter(Boolean);
}

function getRecentDraftTextsForTarget(state, targetKey, limit = 6) {
  return getDraftedWatchRecords(state)
    .filter((record) => String(record.targetKey || '').trim().toLowerCase() === String(targetKey || '').trim().toLowerCase())
    .slice(0, limit)
    .map((record) => normalizeWhitespace([record.title, record.body].filter(Boolean).join(' ')))
    .filter(Boolean);
}

function getImageReuseLimitStatus(state, imageKey, targetKey, watchSettings) {
  const normalizedImageKey = normalizeImageKey(imageKey);
  if (!normalizedImageKey || !watchSettings.imageReuseCooldownMs) {
    return { blocked: false, waitMs: 0, blockedUntil: 0, reason: '' };
  }

  const normalizedTargetKey = String(targetKey || '').trim().toLowerCase();
  const recent = getDraftedWatchRecords(state)
    .filter((record) => normalizeImageKey(record.imageKey) === normalizedImageKey)
    .filter((record) => String(record.targetKey || '').trim().toLowerCase() !== normalizedTargetKey)
    .sort((left, right) => toTimestamp(right.draftedAt || right.updatedAt) - toTimestamp(left.draftedAt || left.updatedAt))[0];

  const draftedAt = toTimestamp(recent?.draftedAt || recent?.updatedAt);
  const blockedUntil = draftedAt ? draftedAt + watchSettings.imageReuseCooldownMs : 0;

  return {
    blocked: blockedUntil > Date.now(),
    waitMs: blockedUntil > Date.now() ? blockedUntil - Date.now() : 0,
    blockedUntil,
    reason: recent?.targetLabel
      ? `same image used recently for ${recent.targetLabel}`
      : 'same image used recently',
  };
}

function normalizeDraftForComparison(text) {
  return normalizeWhitespace(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function getDraftSimilarityScore(leftValue, rightValue) {
  const left = normalizeDraftForComparison(leftValue);
  const right = normalizeDraftForComparison(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if ((left.includes(right) || right.includes(left)) && Math.min(left.length, right.length) >= 36) return 0.95;
  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap++;
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function findSimilarDraft(text, recentDrafts = []) {
  let bestMatch = null;
  let bestScore = 0;
  for (const previous of recentDrafts) {
    const score = getDraftSimilarityScore(text, previous);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = previous;
    }
  }
  return { tooSimilar: bestScore >= 0.76, bestMatch, score: bestScore };
}

function getAccountRateLimitStatus(state, accountId, watchSettings) {
  const hourlyLimit = Number(watchSettings.accountMaxRepliesPerHour) || 0;
  const dailyLimit = Number(watchSettings.accountMaxRepliesPerDay) || 0;
  const now = Date.now();

  let blockedUntil = 0;
  let reason = '';

  if (hourlyLimit > 0) {
    const hourRecords = getRecentDraftRecordsForAccount(state, accountId, 60 * 60 * 1000);
    if (hourRecords.length >= hourlyLimit) {
      const oldestHourAt = toTimestamp(hourRecords[0]?.draftedAt || hourRecords[0]?.updatedAt);
      blockedUntil = Math.max(blockedUntil, oldestHourAt + (60 * 60 * 1000));
      reason = `hourly cap reached (${hourRecords.length}/${hourlyLimit})`;
    }
  }

  if (dailyLimit > 0) {
    const dayRecords = getRecentDraftRecordsForAccount(state, accountId, 24 * 60 * 60 * 1000);
    if (dayRecords.length >= dailyLimit) {
      const oldestDayAt = toTimestamp(dayRecords[0]?.draftedAt || dayRecords[0]?.updatedAt);
      blockedUntil = Math.max(blockedUntil, oldestDayAt + (24 * 60 * 60 * 1000));
      reason = `daily cap reached (${dayRecords.length}/${dailyLimit})`;
    }
  }

  return {
    blocked: blockedUntil > now,
    blockedUntil,
    waitMs: blockedUntil > now ? blockedUntil - now : 0,
    reason,
  };
}

function isWithinActiveHours(settings, now = new Date()) {
  if (!settings.activeHoursEnabled) return true;
  if (settings.activeStartHour === settings.activeEndHour) return true;
  const hour = now.getHours();
  if (settings.activeStartHour < settings.activeEndHour) return hour >= settings.activeStartHour && hour < settings.activeEndHour;
  return hour >= settings.activeStartHour || hour < settings.activeEndHour;
}

function getMsUntilNextActiveWindow(settings, now = new Date()) {
  if (!settings.activeHoursEnabled || isWithinActiveHours(settings, now)) return 0;
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(settings.activeStartHour);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function isUnsafeTarget(target) {
  const source = `${target?.name || ''} ${target?.label || ''}`;
  return UNSAFE_TARGET_RE.test(source);
}

function buildTargetKey(target) {
  return `${target.kind}:${target.name}`.toLowerCase();
}

function buildSubmitUrl(target) {
  return `https://www.reddit.com/r/${encodeURIComponent(target.name)}/submit`;
}

function normalizeSingleTarget(rawInput) {
  const parsed = normalizeTargetProfiles({ targetAccounts: [rawInput] })
    .find((item) => item.kind === 'subreddit');
  return parsed || null;
}

function normalizePlannerTargets(config = {}, botAccounts = [], emit = null) {
  const normalized = normalizeTargetProfiles(config);
  const droppedUsers = normalized.filter((target) => target.kind !== 'subreddit').length;
  const subredditTargets = normalized.filter((target) => target.kind === 'subreddit');
  const safeTargets = [];
  let unsafeCount = 0;

  for (const target of subredditTargets) {
    if (isUnsafeTarget(target)) {
      unsafeCount++;
      continue;
    }
    safeTargets.push(target);
  }

  if (emit && droppedUsers > 0) emit('warn', `Skipped ${droppedUsers} non-subreddit target${droppedUsers === 1 ? '' : 's'} in post mode.`);
  if (emit && unsafeCount > 0) emit('warn', `Skipped ${unsafeCount} unsafe subreddit target${unsafeCount === 1 ? '' : 's'} to keep the planner safe.`);

  return resolveTargetProfileAccounts(safeTargets, botAccounts);
}

function inferTargetTopic(target) {
  const raw = String(target?.name || '').replace(/[_-]+/g, ' ').trim();
  return raw || 'this space';
}

function chooseUniqueDraft(candidates, recentDrafts) {
  for (const candidate of candidates) {
    const combined = normalizeWhitespace([candidate.title, candidate.body].join(' '));
    if (!findSimilarDraft(combined, recentDrafts).tooSimilar) return candidate;
  }
  return candidates[0];
}

function buildFallbackDraft(target, tone, contentPrompt = '', personaNotes = '', recentDrafts = []) {
  const topic = inferTargetTopic(target);
  const prompt = normalizeWhitespace(contentPrompt || '');
  const direction = prompt || `a grounded discussion about ${topic}`;
  const note = personaNotes ? ` ${normalizeWhitespace(personaNotes)}.` : '';

  const titleGroups = {
    'engaging and friendly': [
      `What is one thing people in ${topic} underestimate at the beginning?`,
      `What small shift helped you make faster progress in ${topic}?`,
      `What advice in ${topic} sounded simple but turned out to be really useful?`,
    ],
    'funny and witty': [
      `What part of ${topic} looked easy until you actually tried it?`,
      `What is the most humbling lesson ${topic} taught you early on?`,
      `What in ${topic} deserves more honesty and less pretending?`,
    ],
    'professional and insightful': [
      `What principle in ${topic} keeps proving itself over time?`,
      `What pattern do newcomers in ${topic} usually miss at first?`,
      `What is a practical lesson from ${topic} that changed how you work?`,
    ],
    'casual and relatable': [
      `What is something in ${topic} you wish someone had told you sooner?`,
      `What helped you get unstuck fastest when you started with ${topic}?`,
      `What made ${topic} feel more manageable for you?`,
    ],
    'enthusiastic and hype': [
      `What gave you the biggest momentum boost in ${topic}?`,
      `What win in ${topic} mattered more than you expected?`,
      `What keeps you excited about ${topic} even when it gets messy?`,
    ],
    'thoughtful and deep': [
      `What truth about ${topic} only became obvious after real experience?`,
      `What has ${topic} taught you that surprised you about yourself?`,
      `What part of ${topic} feels more nuanced the longer you stay with it?`,
    ],
    'sexy and engaging': [
      `What part of ${topic} keeps pulling you back in even when you know better?`,
      `What is the most irresistible thing about ${topic} that no one talks about?`,
      `What aspect of ${topic} makes it impossible to look away?`,
    ],
    'controversial sexy': [
      `What about ${topic} do most people pretend they are not interested in?`,
      `What is the thing about ${topic} everyone notices but no one admits?`,
      `What uncomfortable truth about ${topic} actually makes it more interesting?`,
    ],
    'sexy and flirty': [
      `What in ${topic} makes you want to come back for more every time?`,
      `What is the one thing about ${topic} that gets better the more attention you give it?`,
      `What keeps you interested in ${topic} even when you know you should move on?`,
    ],
  };

  const bodyGroups = {
    'engaging and friendly': [
      `I have been thinking about ${direction}, and I keep noticing that people talk about the flashy side more than the practical side. I would rather hear the boring answer that actually worked.${note}\n\nIf you have a concrete example, what changed the game for you?`,
      `I keep coming back to ${direction} because the best lessons usually sound almost too simple. I am curious which habit, mindset, or decision made a bigger difference for you than expected.${note}`,
    ],
    'funny and witty': [
      `Every corner of ${topic} seems to come with advice that sounds brilliant until real life gets involved. I would love to hear the version that survived contact with reality.${note}\n\nWhat actually held up for you?`,
      `It feels like ${topic} has a special talent for humbling people fast. I am curious which lesson looked obvious in hindsight but took actual experience to learn.${note}`,
    ],
    'professional and insightful': [
      `I have been collecting better examples around ${direction}, especially the practical lessons that keep compounding over time. The flashy tactics are easy to find, but the repeatable principles are usually harder to surface.${note}\n\nWhat has stayed useful for you?`,
      `There is a lot of surface-level advice around ${topic}, but I am more interested in what keeps proving itself in real situations.${note}\n\nWhat principle or pattern has held up best for you?`,
    ],
    'casual and relatable': [
      `I have been trying to think about ${direction} in a more realistic way. A lot of the usual advice sounds fine on paper, but I am more curious about what made things feel simpler or less overwhelming for real people.${note}\n\nWhat helped you most?`,
      `Sometimes the most useful lessons in ${topic} are the ones that sound almost too obvious to post about. I would love to hear the thing that quietly made life easier for you.${note}`,
    ],
    'enthusiastic and hype': [
      `I like hearing about the turning points in ${topic} that created real momentum instead of just feeling exciting for a day.${note}\n\nWhat gave you the most lift once you got going?`,
      `There is a big difference between something that sounds motivating and something that actually creates momentum. I am curious which move, habit, or mindset really helped you level up in ${topic}.${note}`,
    ],
    'thoughtful and deep': [
      `The longer I pay attention to ${direction}, the more it feels like the most useful lessons are rarely the loudest ones.${note}\n\nWhat truth only became clear after you had more real experience?`,
      `I have been thinking about how ${topic} changes once you move past the beginner view and start seeing the tradeoffs more clearly.${note}\n\nWhat became more nuanced for you over time?`,
    ],
    'sexy and engaging': [
      `There is something about ${direction} that is genuinely hard to ignore once you have experienced it.${note}\n\nWhat keeps you coming back, even when you tell yourself you should focus on other things?`,
      `I keep finding that the most magnetic parts of ${topic} are the ones nobody bothers to explain properly.${note}\n\nWhat pulled you in more than you expected?`,
    ],
    'controversial sexy': [
      `I think ${direction} is way more interesting than people let themselves admit publicly.${note}\n\nWhat is the part of ${topic} you are actually curious about but would not usually bring up?`,
      `There is a version of ${topic} that most people engage with in private but rarely talk about openly.${note}\n\nWhat aspect of it would you actually discuss if there were no social consequences?`,
    ],
    'sexy and flirty': [
      `Every time I think I have figured out ${direction}, it surprises me again in a good way.${note}\n\nWhat keeps it interesting for you even after you think you know what to expect?`,
      `There is something quietly addictive about ${topic} that is hard to explain to people who have not tried it.${note}\n\nWhat made it click for you?`,
    ],
  };

  const titlePool = titleGroups[tone] || titleGroups['engaging and friendly'];
  const bodyPool = bodyGroups[tone] || bodyGroups['engaging and friendly'];
  const candidates = titlePool.flatMap((title) => bodyPool.map((body) => ({
    title: trimText(title, 110),
    body: trimBody(body, 650),
  })));

  return chooseUniqueDraft(candidates, recentDrafts);
}

function buildRiskSafeFallbackDraft(target, contentPrompt = '') {
  const topic = inferTargetTopic(target);
  const direction = normalizeWhitespace(contentPrompt || '') || `a grounded discussion about ${topic}`;
  return {
    title: trimText(`What perspective on ${topic} became more useful with experience?`, 110),
    body: trimBody(`I have been thinking about ${direction}, and I would rather hear practical lessons than perfect-sounding advice. If you have real experience here, what perspective, habit, or decision ended up mattering more than expected?`, 420),
  };
}

function parseGeminiDraft(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  let title = '';
  let body = '';

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (/^title:/i.test(trimmed)) title = trimmed.replace(/^title:\s*/i, '').trim();
    if (/^body:/i.test(trimmed)) body = trimmed.replace(/^body:\s*/i, '').trim();
  }

  if (!title && !body && text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      title = normalizeWhitespace(parsed.title || '');
      body = normalizeMultiline(parsed.body || '');
    } catch {}
  }

  title = trimText(title, 110);
  body = trimBody(body, 700);
  if (!title || !body) return null;
  return { title, body };
}

async function runGeminiPrompt(genAI, modelCandidates, text) {
  let lastError = null;

  for (const model of modelCandidates) {
    try {
      const response = await genAI.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text }] }],
      });
      let raw = '';
      if (typeof response.text === 'string') raw = response.text;
      else if (response.candidates?.[0]?.content?.parts?.[0]?.text) raw = response.candidates[0].content.parts[0].text;
      const output = String(raw || '').trim();
      if (!output) throw new Error(`Gemini returned empty output for ${model}`);
      return output;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('No Gemini model succeeded');
}

async function generateGeminiDraft(target, tone, geminiApiKey, emit = null, options = {}) {
  if (!geminiApiKey) return null;

  const recentDrafts = Array.isArray(options.recentDrafts) ? options.recentDrafts.filter(Boolean).slice(0, 10) : [];
  const contentPrompt = normalizeWhitespace(options.contentPrompt || '').slice(0, 240);
  const personaNotes = normalizeWhitespace(options.personaNotes || '').slice(0, 240);

  const toneInstructions = {
    'engaging and friendly': 'Warm, clear, and easy to respond to.',
    'funny and witty': 'Lightly witty, sharp, and still useful.',
    'professional and insightful': 'Practical, concrete, and thoughtful.',
    'casual and relatable': 'Relaxed, human, and conversational.',
    'enthusiastic and hype': 'Positive, motivating, and grounded.',
    'thoughtful and deep': 'Reflective, nuanced, and emotionally intelligent.',
    'sexy and engaging': 'Magnetic, suggestive, and attention-grabbing. Tasteful — no explicit language. Make readers want to engage.',
    'controversial sexy': 'Bold, a little provocative, and scroll-stopping. Say something unexpected and slightly edgy but tasteful.',
    'sexy and flirty': 'Playful, teasing, and lightly flirtatious. Leaves readers wanting more. No explicit language.',
  };

  try {
    const { GoogleGenAI } = require('@google/genai');
    const genAI = new GoogleGenAI({ apiKey: geminiApiKey });
    const modelCandidates = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

    const prompt = [
      `Write one safe, original Reddit self-post draft for ${target.label}.`,
      `Tone: ${toneInstructions[tone] || toneInstructions['engaging and friendly']}`,
      contentPrompt ? `Theme: ${contentPrompt}` : `Theme: a discussion people in ${inferTargetTopic(target)} would find useful`,
      personaNotes ? `Subreddit notes: ${personaNotes}` : '',
      recentDrafts.length ? `Avoid sounding like these recent drafts:\n${recentDrafts.map((item) => `- ${item}`).join('\n')}` : '',
      'Rules:',
      '- Safe for a general audience',
      '- No explicit sexual content, no minors, no suggestive age ambiguity',
      '- No spam, no promo, no links, no sales language, no contact handles',
      '- Title under 110 characters',
      '- Body should be one short paragraph or two short paragraphs',
      '- Make it discussion-friendly, specific, and human',
      '- Do not mention being AI',
      '- Return exactly these two lines and nothing else',
      'TITLE: <title>',
      'BODY: <body>',
    ].filter(Boolean).join('\n');

    const raw = await runGeminiPrompt(genAI, modelCandidates, prompt);
    const parsed = parseGeminiDraft(raw);
    if (!parsed) throw new Error('Gemini returned an unparseable draft');
    return parsed;
  } catch (err) {
    if (emit) emit('warn', `Gemini failed (${getErrorMessage(err)}) - using local fallback.`);
    return null;
  }
}

function getDraftSafetyAssessment(draft, options = {}) {
  const title = normalizeWhitespace(draft?.title || '');
  const body = normalizeMultiline(draft?.body || '');
  const combined = normalizeWhitespace([title, body].join(' '));
  const recentDrafts = Array.isArray(options.recentDrafts) ? options.recentDrafts : [];
  const recentTargetDrafts = Array.isArray(options.recentTargetDrafts) ? options.recentTargetDrafts : [];
  const reasons = [];

  if (!title || title.length < 12) reasons.push('title too short');
  if (!body || body.length < 40) reasons.push('body too short');
  if (title.length > 110) reasons.push('title too long');
  if (body.length > 900) reasons.push('body too long');
  if (BLOCKED_PROMO_RE.test(combined)) reasons.push('links or promo language not allowed');
  if (BLOCKED_EXPLICIT_RE.test(combined)) reasons.push('explicit language not allowed');
  if (BLOCKED_MINOR_RE.test(combined)) reasons.push('minor or age-risk language not allowed');
  if (/[!?]{4,}/.test(combined)) reasons.push('too much punctuation');
  if ((combined.match(/#/g) || []).length) reasons.push('hashtags not allowed');

  const similarity = findSimilarDraft(combined, recentDrafts);
  if (similarity.tooSimilar) reasons.push('too similar to a recent draft');

  const targetSimilarity = findSimilarDraft(combined, recentTargetDrafts);
  if (options.threadLockEnabled && targetSimilarity.tooSimilar) reasons.push('too similar to the latest draft for this subreddit');

  return {
    blocked: reasons.length > 0,
    reasons,
    similarity,
    targetSimilarity,
  };
}

async function generateDraft(target, tone, geminiApiKey, emit, options = {}) {
  const toneUsed = target?.toneOverride || normalizeToneValue(tone) || 'engaging and friendly';
  const recentDrafts = Array.isArray(options.recentDrafts) ? options.recentDrafts : [];
  const recentTargetDrafts = Array.isArray(options.recentTargetDrafts) ? options.recentTargetDrafts : [];
  const contentPrompt = normalizeWhitespace(options.contentPrompt || '');
  const personaNotes = normalizeWhitespace(target?.personaNotes || options.personaNotes || '');

  let draft = await generateGeminiDraft(target, toneUsed, geminiApiKey, emit, {
    recentDrafts,
    contentPrompt,
    personaNotes,
  });

  if (!draft) {
    if (emit && !geminiApiKey) emit('warn', 'Gemini key missing - using local safe draft builder.');
    draft = buildFallbackDraft(target, toneUsed, contentPrompt, personaNotes, recentDrafts);
  }

  let assessment = getDraftSafetyAssessment(draft, {
    recentDrafts,
    recentTargetDrafts,
    threadLockEnabled: !!options.threadLockEnabled,
  });

  if (options.riskGuardEnabled && assessment.blocked) {
    if (emit) emit('warn', `Risk guard adjusted the draft (${assessment.reasons.join(', ')}).`);
    draft = buildRiskSafeFallbackDraft(target, contentPrompt);
    assessment = getDraftSafetyAssessment(draft, {
      recentDrafts,
      recentTargetDrafts,
      threadLockEnabled: !!options.threadLockEnabled,
    });
  }

  if (assessment.blocked) {
    throw new Error(`Safety guard blocked draft: ${assessment.reasons.join(', ')}`);
  }

  return {
    ...draft,
    toneUsed,
    submitUrl: buildSubmitUrl(target),
  };
}

function getPlannedAccount(session, target) {
  const defaultAccount = getDefaultBotAccount(session.botAccounts);
  const explicit = session.botAccounts.find((item) => item.id === target.postingAccountId);
  const resolved = explicit || defaultAccount || null;
  return {
    id: resolved?.id || target.postingAccountId || '__planner__',
    name: resolved?.name || target.postingAccountName || defaultAccount?.name || 'Active Account',
  };
}

function noteDraftSuccess(session) {
  session.consecutiveFailures = 0;
}

function noteDraftFailure(session, watchSettings, emit) {
  session.consecutiveFailures = (session.consecutiveFailures || 0) + 1;
  if (!watchSettings.pauseOnFailureEnabled) return;
  if (session.consecutiveFailures < watchSettings.consecutiveFailureLimit) return;

  session.pausedUntil = Date.now() + watchSettings.pauseMsOnFailure;
  session.pauseNoticeAt = 0;
  session.consecutiveFailures = 0;
  if (emit) emit('warn', `Safety pause started for ${formatDuration(watchSettings.pauseMsOnFailure)} after repeated draft failures.`);
}

function pickNextEligibleTarget(session, watchState) {
  const targets = session.targetProfiles || [];
  if (!targets.length) return { target: null, waitMs: session.watchSettings.pollIntervalMs };

  let shortestWait = session.watchSettings.pollIntervalMs;
  let reason = 'waiting for the next draft slot';

  for (let index = 0; index < targets.length; index++) {
    const cursor = (session.targetCursor + index) % targets.length;
    const target = targets[cursor];
    const targetKey = buildTargetKey(target);
    const account = getPlannedAccount(session, target);

    const targetRecord = getLatestDraftForTarget(watchState, targetKey);
    const lastDraftAt = toTimestamp(targetRecord?.draftedAt || targetRecord?.updatedAt);
    if (session.watchSettings.safeModeEnabled && session.watchSettings.perTargetCooldownMs > 0 && lastDraftAt) {
      const remainingMs = session.watchSettings.perTargetCooldownMs - (Date.now() - lastDraftAt);
      if (remainingMs > 0) {
        if (remainingMs < shortestWait) {
          shortestWait = remainingMs;
          reason = `cooldown active for ${target.label}`;
        }
        continue;
      }
    }

    if (session.watchSettings.safeModeEnabled) {
      const capStatus = getAccountRateLimitStatus(watchState, account.id, session.watchSettings);
      if (capStatus.blocked) {
        if (capStatus.waitMs > 0 && capStatus.waitMs < shortestWait) {
          shortestWait = capStatus.waitMs;
          reason = `${account.name} is capped right now`;
        }
        continue;
      }

      const imageStatus = getImageReuseLimitStatus(
        watchState,
        session.contentImageKey,
        targetKey,
        session.watchSettings
      );
      if (imageStatus.blocked) {
        if (imageStatus.waitMs > 0 && imageStatus.waitMs < shortestWait) {
          shortestWait = imageStatus.waitMs;
          reason = `${imageStatus.reason} (${formatDuration(imageStatus.waitMs)} left)`;
        }
        continue;
      }
    }

    session.targetCursor = (cursor + 1) % targets.length;
    return { target, account, waitMs: 0, reason: '' };
  }

  return { target: null, waitMs: Math.max(15000, shortestWait), reason };
}

function emitEvent(emit, type, message, extra = {}) {
  emit({ type, message, ...extra });
}

async function createDraftRecord(session, target, watchState, emit) {
  const targetKey = buildTargetKey(target);
  const account = getPlannedAccount(session, target);
  const recentDrafts = getRecentDraftTexts(watchState, 12);
  const recentTargetDrafts = getRecentDraftTextsForTarget(watchState, targetKey, 6);

  if (session.watchSettings.safeModeEnabled) {
    const latestTargetDraft = getLatestDraftForTarget(watchState, targetKey);
    const lastTargetDraftAt = toTimestamp(latestTargetDraft?.draftedAt || latestTargetDraft?.updatedAt);
    if (session.watchSettings.perTargetCooldownMs > 0 && lastTargetDraftAt) {
      const remainingMs = session.watchSettings.perTargetCooldownMs - (Date.now() - lastTargetDraftAt);
      if (remainingMs > 0) {
        throw new Error(`Subreddit cooldown active (${formatDuration(remainingMs)} left)`);
      }
    }

    const capStatus = getAccountRateLimitStatus(watchState, account.id, session.watchSettings);
    if (capStatus.blocked) {
      throw new Error(`${account.name} ${capStatus.reason} (${formatDuration(capStatus.waitMs)} left)`);
    }

    const imageStatus = getImageReuseLimitStatus(watchState, session.contentImageKey, targetKey, session.watchSettings);
    if (imageStatus.blocked) {
      throw new Error(`${imageStatus.reason} (${formatDuration(imageStatus.waitMs)} left)`);
    }
  }

  const draft = await generateDraft(
    target,
    session.tone,
    session.geminiApiKey,
    (type, message) => emitEvent(emit, type, message),
    {
      riskGuardEnabled: session.watchSettings.riskGuardEnabled,
      threadLockEnabled: session.watchSettings.threadLockEnabled,
      recentDrafts,
      recentTargetDrafts,
      contentPrompt: session.contentPrompt,
      personaNotes: target.personaNotes,
    }
  );

  const draftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const draftedAt = new Date().toISOString();

  upsertWatchRecord(watchState, draftId, {
    status: 'drafted',
    draftedAt,
    targetKey,
    targetLabel: target.label,
    postingAccountId: account.id,
    postingAccountName: account.name,
    toneUsed: draft.toneUsed,
    title: draft.title,
    body: draft.body,
    submitUrl: draft.submitUrl,
    imageKey: session.contentImageKey || '',
  });
  saveWatchState(watchState);

  return {
    id: draftId,
    draftedAt,
    targetKey,
    targetLabel: target.label,
    postingAccountId: account.id,
    postingAccountName: account.name,
    toneUsed: draft.toneUsed,
    title: draft.title,
    body: draft.body,
    submitUrl: draft.submitUrl,
    imageKey: session.contentImageKey || '',
  };
}

async function finishSession(session, type, message) {
  if (currentSession !== session) return;
  currentSession = null;
  session.status = type === 'error' ? 'error' : 'stopped';
  if (session.emit && message) emitEvent(session.emit, type, message);
}

async function runPlanner(session) {
  const emit = session.emit;
  const watchState = loadWatchState();

  emitEvent(emit, 'info', `Planner ready - ${session.targetProfiles.length} safe subreddit target(s), one draft every ${session.watchSettings.pollIntervalMinutes}m.`);
  emitEvent(emit, 'info', session.watchSettings.manualApprovalEnabled
    ? 'Manual approval is on - the app prepares drafts and opens no live posts by itself.'
    : 'Draft mode is active.'
  );
  if (session.contentPrompt) emitEvent(emit, 'info', `Content prompt: ${trimText(session.contentPrompt, 140)}`);
  if (session.contentImageKey) {
    emitEvent(emit, 'info', `Image reuse guard active - same media waits at least ${session.watchSettings.imageReuseCooldownMinutes}m before another subreddit.`);
  }
  if (session.watchSettings.activeHoursEnabled) {
    emitEvent(emit, 'info', `Active hours enabled - ${formatActiveHours(session.watchSettings)}.`);
  }

  while (currentSession === session) {
    if (session.stopRequested) {
      await finishSession(session, 'stopped', 'Planner stopped.');
      return;
    }

    if (session.repliesCount >= session.maxReplies) {
      await finishSession(session, 'done', `Planner finished - ${session.repliesCount} draft${session.repliesCount === 1 ? '' : 's'} prepared.`);
      return;
    }

    if ((Date.now() - session.startedAt) >= session.maxMs) {
      await finishSession(session, 'done', `Session time limit reached after ${formatDuration(session.maxMs)}.`);
      return;
    }

    if (!isWithinActiveHours(session.watchSettings)) {
      const waitMs = getMsUntilNextActiveWindow(session.watchSettings);
      if (!session.activeHoursNoticeAt || Date.now() - session.activeHoursNoticeAt > 60 * 1000) {
        session.activeHoursNoticeAt = Date.now();
        emitEvent(emit, 'info', `Outside active hours - next window opens in ${formatDuration(waitMs)}.`);
      }
      await sleep(Math.min(waitMs || 15000, 30000));
      continue;
    }

    if (session.pausedUntil && session.pausedUntil > Date.now()) {
      const waitMs = session.pausedUntil - Date.now();
      if (!session.pauseNoticeAt || Date.now() - session.pauseNoticeAt > 60 * 1000) {
        session.pauseNoticeAt = Date.now();
        emitEvent(emit, 'warn', `Planner is paused for ${formatDuration(waitMs)} after repeated failures.`);
      }
      await sleep(Math.min(waitMs, 30000));
      continue;
    }

    if (Date.now() < session.nextDraftAt) {
      await sleep(Math.min(session.nextDraftAt - Date.now(), 1000));
      continue;
    }

    const choice = pickNextEligibleTarget(session, watchState);
    if (!choice.target) {
      if (!session.idleNoticeAt || Date.now() - session.idleNoticeAt > 60 * 1000) {
        session.idleNoticeAt = Date.now();
        emitEvent(emit, 'info', `${choice.reason || 'No eligible targets right now'} - checking again soon.`);
      }
      session.nextDraftAt = Date.now() + Math.min(choice.waitMs || session.watchSettings.pollIntervalMs, session.watchSettings.pollIntervalMs);
      await sleep(1000);
      continue;
    }

    try {
      const draft = await createDraftRecord(session, choice.target, watchState, emit);
      noteDraftSuccess(session);
      session.repliesCount += 1;
      session.idleNoticeAt = 0;
      session.nextDraftAt = Date.now() + session.watchSettings.pollIntervalMs;

      emitEvent(
        emit,
        'draft',
        `Draft ${session.repliesCount}/${session.maxReplies} ready for ${draft.targetLabel}.`,
        { count: session.repliesCount, draft }
      );
    } catch (err) {
      noteDraftFailure(session, session.watchSettings, (type, message) => emitEvent(emit, type, message));
      session.nextDraftAt = Date.now() + Math.min(session.watchSettings.pollIntervalMs, 60 * 1000);
      emitEvent(emit, 'error', `Draft failed for ${choice.target.label}: ${getErrorMessage(err)}`);
    }
  }
}

async function runSingleDraft(config, emit, persistToCurrentSession = false) {
  const botAccounts = normalizeBotAccounts(config);
  const watchSettings = normalizeWatchSettings(config.watchSettings);
  const rawTarget = String(config.targetPostUrl || '').trim();
  const target = normalizeSingleTarget(rawTarget);
  if (!target) throw new Error('Enter a subreddit like r/startups or a subreddit URL.');
  if (target.kind !== 'subreddit') throw new Error('Single Draft mode only supports subreddit targets.');
  if (isUnsafeTarget(target)) throw new Error('That subreddit is blocked in safe post mode.');

  const singleTarget = {
    ...target,
    postingAccountId: String(config.targetPostPostingAccountId || '__active__').trim() || '__active__',
    postingAccountName: '',
  };
  const [resolvedTarget] = resolveTargetProfileAccounts([singleTarget], botAccounts);
  const watchState = loadWatchState();
  const session = persistToCurrentSession ? currentSession : {
    botAccounts,
    watchSettings,
    tone: normalizeToneValue(config.tone) || 'engaging and friendly',
    geminiApiKey: String(config.geminiApiKey || '').trim(),
    contentPrompt: normalizeWhitespace(config.contentPrompt || ''),
    contentImageKey: normalizeImageKey(config.contentImageKey || ''),
    emit,
  };

  emitEvent(emit, 'info', `Preparing one safe draft for ${resolvedTarget.label}.`);
  if (session.contentPrompt) emitEvent(emit, 'info', `Content prompt: ${trimText(session.contentPrompt, 140)}`);
  if (session.contentImageKey) {
    emitEvent(emit, 'info', `Image/media key set - enforcing ${session.watchSettings.imageReuseCooldownMinutes}m reuse cooldown.`);
  }

  const draft = await createDraftRecord(session, resolvedTarget, watchState, emit);
  emitEvent(emit, 'draft', `Draft ready for ${draft.targetLabel}.`, { count: 1, draft });
  emitEvent(emit, 'done', 'Single draft complete.');
}

function startSession(config, onEvent) {
  if (currentSession) {
    throw new Error('A session is already running');
  }

  const emit = (event) => {
    try {
      onEvent?.(event);
    } catch {}
  };

  const botAccounts = normalizeBotAccounts(config);
  const watchSettings = normalizeWatchSettings(config.watchSettings);
  const tone = normalizeToneValue(config.tone) || 'engaging and friendly';
  const geminiApiKey = String(config.geminiApiKey || '').trim();
  const contentPrompt = normalizeWhitespace(config.contentPrompt || '');
  const contentImageKey = normalizeImageKey(config.contentImageKey || '');
  const isSingleDraftMode = !!String(config.targetPostUrl || '').trim() && config?.targetAccounts?.[0] === '__target__';

  if (isSingleDraftMode) {
    currentSession = {
      status: 'running',
      startedAt: Date.now(),
      repliesCount: 0,
      maxReplies: 1,
      maxMs: 60 * 60 * 1000,
      stopRequested: false,
      emit,
      botAccounts,
      watchSettings,
      tone,
      geminiApiKey,
      contentPrompt,
      contentImageKey,
    };

    runSingleDraft(config, emit, true).catch(async (err) => {
      await finishSession(currentSession, 'error', getErrorMessage(err));
    });
    return;
  }

  const targetProfiles = normalizePlannerTargets(config, botAccounts, (type, message) => emitEvent(emit, type, message));
  if (!targetProfiles.length) {
    throw new Error('Add at least one safe subreddit target before starting the planner.');
  }

  currentSession = {
    status: 'running',
    startedAt: Date.now(),
    repliesCount: 0,
    maxReplies: watchSettings.watchMode ? watchSettings.sessionMaxReplies : 1,
    maxMs: watchSettings.sessionMaxMs,
    stopRequested: false,
    emit,
    botAccounts,
    targetProfiles,
    targetCursor: 0,
    nextDraftAt: Date.now(),
    pausedUntil: 0,
    pauseNoticeAt: 0,
    activeHoursNoticeAt: 0,
    idleNoticeAt: 0,
    consecutiveFailures: 0,
    watchSettings,
    tone,
    geminiApiKey,
    contentPrompt,
    contentImageKey,
  };

  runPlanner(currentSession).catch(async (err) => {
    await finishSession(currentSession, 'error', getErrorMessage(err));
  });
}

function stopSession() {
  if (currentSession) {
    currentSession.stopRequested = true;
  }
}

function getSessionState() {
  if (!currentSession) {
    return { status: 'idle', startedAt: null, repliesCount: 0, maxReplies: 0, maxMs: 0 };
  }

  return {
    status: currentSession.status || 'running',
    startedAt: currentSession.startedAt,
    repliesCount: currentSession.repliesCount || 0,
    maxReplies: currentSession.maxReplies || 0,
    maxMs: currentSession.maxMs || 0,
  };
}

async function runTest(config, onEvent) {
  const emit = (event) => {
    try {
      onEvent?.(event);
    } catch {}
  };

  await runSingleDraft(config, emit, false);
}

module.exports = {
  DEFAULT_WATCH_SETTINGS,
  startSession,
  stopSession,
  getSessionState,
  runTest,
  resetWatchState,
};
