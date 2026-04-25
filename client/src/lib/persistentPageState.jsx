import { useStepTimer } from '../hooks/useStepTimer';
import { Badge, Card, Spinner } from '../components/UI';

const INTERRUPTED_JOB_MESSAGE = 'This request was interrupted by a page reload. Please start it again.';

function cleanQueueItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((job) => job && typeof job === 'object');
}

export function normalizePersistedQueueItems(items) {
  return cleanQueueItems(items).map((job) => (
    job.status === 'running'
      ? { ...job, status: 'error', errorMessage: job.errorMessage || INTERRUPTED_JOB_MESSAGE }
      : job
  ));
}

export function preparePersistedQueueItems(items) {
  return cleanQueueItems(items);
}

function normalizePersistedValue(key, value) {
  if (key === 'queueItems') return normalizePersistedQueueItems(value);
  return value;
}

function preparePersistedValue(key, value) {
  if (key === 'queueItems') return preparePersistedQueueItems(value);
  return value;
}

function readPersistedState(storageKey, persistKeys) {
  if (typeof window === 'undefined' || !storageKey || !persistKeys?.length) return {};
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const next = {};
    for (const key of persistKeys) {
      if (key in parsed) next[key] = normalizePersistedValue(key, parsed[key]);
    }
    return next;
  } catch {
    return {};
  }
}

function persistState(storageKey, persistKeys, cache) {
  if (typeof window === 'undefined' || !storageKey || !persistKeys?.length) return;
  try {
    const payload = {};
    let hasValue = false;
    for (const key of persistKeys) {
      const value = preparePersistedValue(key, cache[key]);
      const isEmptyArray = Array.isArray(value) && value.length === 0;
      if (value == null || isEmptyArray) continue;
      payload[key] = value;
      hasValue = true;
    }
    if (!hasValue) {
      window.sessionStorage.removeItem(storageKey);
      return;
    }
    window.sessionStorage.setItem(storageKey, JSON.stringify(payload));
  } catch {
    // Ignore storage quota/private-mode failures and keep in-memory behavior.
  }
}

export function createPersistentPageState(namespace, initialState, persistKeys = ['queueItems']) {
  const storageKey = namespace ? `kyros.${namespace}` : null;
  const cache = {
    ...initialState,
    ...readPersistedState(storageKey, persistKeys),
  };
  const listeners = new Set();

  const getSnapshot = () => ({ ...cache });

  const emit = () => {
    const snapshot = getSnapshot();
    for (const listener of listeners) listener(snapshot);
  };

  const subscribe = (listener) => {
    listeners.add(listener);
    listener(getSnapshot());
    return () => listeners.delete(listener);
  };

  const setValue = (key, next) => {
    cache[key] = typeof next === 'function' ? next(cache[key]) : next;
    persistState(storageKey, persistKeys, cache);
    emit();
    return cache[key];
  };

  const patch = (next) => {
    const updates = typeof next === 'function' ? next(getSnapshot()) : next;
    if (updates && typeof updates === 'object') {
      Object.assign(cache, updates);
      persistState(storageKey, persistKeys, cache);
      emit();
    }
    return getSnapshot();
  };

  return {
    getSnapshot,
    subscribe,
    setValue,
    patch,
  };
}

export function makePersistentJobId(prefix = 'job') {
  return globalThis.crypto?.randomUUID?.()
    || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function PersistentJobCard({
  job,
  steps,
  thresholds,
  onDismiss,
  runningColor = 'blue',
  idleHint = 'You can leave this page and come back while it is still running.',
}) {
  const safeSteps = Array.isArray(steps) && steps.length > 0 ? steps : ['Processing request'];
  const safeThresholds = Array.isArray(thresholds) ? thresholds : [];
  const { elapsedSec, stepIndex } = useStepTimer(job?.status === 'running', safeThresholds);
  const currentStep = safeSteps[Math.min(stepIndex, safeSteps.length - 1)];

  return (
    <Card className="!p-0 overflow-hidden">
      <div className="relative border-b border-zinc-800/70 bg-zinc-950/80 p-4">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.16),transparent_55%)]" />
        <div className="relative space-y-3">
          <div className="flex items-center justify-between gap-2">
            <Badge color={job?.status === 'running' ? runningColor : 'red'}>
              {job?.status === 'running' ? (job?.label || 'Processing') : 'Failed'}
            </Badge>
            {job?.meta ? <span className="text-[10px] font-mono text-zinc-500">{job.meta}</span> : null}
          </div>

          {job?.status === 'running' ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Spinner size={18} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-zinc-100">{currentStep}</div>
                  <div className="text-xs text-zinc-500">{elapsedSec}s elapsed</div>
                </div>
              </div>
              <div className="space-y-1.5">
                {safeSteps.map((step, idx) => (
                  <div
                    key={step}
                    className={`flex items-center gap-2 text-[11px] ${
                      idx < stepIndex ? 'text-green-400' : idx === stepIndex ? 'text-blue-300' : 'text-zinc-600'
                    }`}
                  >
                    <span className="w-4 text-center">{idx < stepIndex ? '✓' : idx === stepIndex ? '›' : '○'}</span>
                    <span>{step}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2">
              <div className="text-sm font-medium text-red-300">Request failed</div>
              <div className="mt-1 text-xs text-red-200/80 line-clamp-4">{job?.errorMessage || 'Something went wrong'}</div>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2 p-3">
        {job?.summary ? <div className="text-sm text-zinc-200 line-clamp-3">{job.summary}</div> : null}
        {Array.isArray(job?.badges) && job.badges.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {job.badges.map((badge, index) => (
              <Badge key={`${badge?.label || badge}-${index}`} color={badge?.color || 'zinc'}>
                {badge?.label || badge}
              </Badge>
            ))}
          </div>
        ) : null}
        {job?.status === 'running' ? (
          <div className="text-[11px] text-zinc-500">{idleHint}</div>
        ) : (
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => onDismiss?.(job?.id)}
              className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}
