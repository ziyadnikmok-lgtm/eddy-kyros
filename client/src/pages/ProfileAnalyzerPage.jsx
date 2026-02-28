import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { profileAnalyzer as analyzerApi, styleLibrary as libraryApi } from '../services/api';
import { Card, Btn, Input, Select, Badge, Spinner, Empty, ProgressBar } from '../components/UI';
import { IconArrowsBoldOppositeDirection, IconColorPalette, IconDeleteX } from 'nucleo-glass';

// Module-level session cache — survives unmount/remount when navigating away and back
const _cache = {
  username: '',
  postLimit: 12,
  sort: 'newest',
  newerThan: '',
  results: [],
  checkedAtoms: new Set(),
  progress: null,
  contentPatterns: null,
  profiles: [],
};

export default function ProfileAnalyzerPage() {
  const { notify, navigateTo } = useApp();

  const [username, setUsername] = useState(_cache.username);
  const [postLimit, setPostLimit] = useState(_cache.postLimit);
  const [sort, setSort] = useState(_cache.sort);   // 'newest' | 'oldest'
  const [newerThan, setNewerThan] = useState(_cache.newerThan); // e.g. "30 days", "2025-01-01"
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(_cache.progress); // { current, total, status }
  const [results, setResults] = useState(_cache.results); // [{postIndex, postUrl, atoms: [{category, text, tags}]}]
  const [checkedAtoms, setCheckedAtoms] = useState(_cache.checkedAtoms); // "postIdx-atomIdx" keys
  const [saving, setSaving] = useState(false);
  const [profiles, setProfiles] = useState(_cache.profiles);
  const [contentPatterns, setContentPatterns] = useState(_cache.contentPatterns);
  const eventSourceRef = useRef(null);
  const analyzingRef = useRef(false);

  useEffect(() => {
    analyzingRef.current = analyzing;
  }, [analyzing]);

  // ── Session cache sync ──
  useEffect(() => { _cache.username = username; }, [username]);
  useEffect(() => { _cache.postLimit = postLimit; }, [postLimit]);
  useEffect(() => { _cache.sort = sort; }, [sort]);
  useEffect(() => { _cache.newerThan = newerThan; }, [newerThan]);
  useEffect(() => { _cache.results = results; }, [results]);
  useEffect(() => { _cache.checkedAtoms = checkedAtoms; }, [checkedAtoms]);
  useEffect(() => { _cache.progress = progress; }, [progress]);
  useEffect(() => { _cache.contentPatterns = contentPatterns; }, [contentPatterns]);
  useEffect(() => { _cache.profiles = profiles; }, [profiles]);

  // Fetch analyzed profiles on mount
  useEffect(() => {
    libraryApi.profiles().then(setProfiles).catch(() => {});
  }, []);

  // Close EventSource on unmount to prevent leaked connections
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  // Total atoms across all results
  const allAtomKeys = useMemo(() => {
    const keys = [];
    results.forEach((post, pi) => {
      post.atoms.forEach((_, ai) => {
        keys.push(`${pi}-${ai}`);
      });
    });
    return keys;
  }, [results]);

  const checkedCount = checkedAtoms.size;

  // ─── Analysis ─────────────────────────────────────────
  const startAnalysis = () => {
    if (!username.trim() || analyzing) return;

    // Close any previous EventSource to prevent leaked connections
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    setAnalyzing(true);
    analyzingRef.current = true;
    setResults([]);
    setCheckedAtoms(new Set());
    setContentPatterns(null);
    setProgress({ current: 0, total: 0, status: 'Starting...' });

    const es = analyzerApi.analyze(username.trim(), postLimit, {
      sort,
      newerThan: newerThan.trim() || undefined,
    });
    eventSourceRef.current = es;

    es.addEventListener('progress', (e) => {
      try {
        const data = JSON.parse(e.data);
        setProgress(data);
      } catch { /* ignore */ }
    });

    es.addEventListener('atoms', (e) => {
      try {
        const data = JSON.parse(e.data);
        let newChecked;
        setResults(prev => {
          const next = [...prev, data];
          // Auto-check atoms >= 15 chars
          newChecked = new Set();
          data.atoms.forEach((atom, ai) => {
            if (atom.text.length >= 15) {
              newChecked.add(`${next.length - 1}-${ai}`);
            }
          });
          return next;
        });
        setCheckedAtoms(prev2 => {
          const merged = new Set(prev2);
          for (const key of newChecked) merged.add(key);
          return merged;
        });
      } catch { /* ignore */ }
    });

    es.addEventListener('contentPatterns', (e) => {
      try {
        setContentPatterns(JSON.parse(e.data));
      } catch { /* ignore */ }
    });

    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      es.close();
      setAnalyzing(false);
      analyzingRef.current = false;
    };

    es.addEventListener('complete', (e) => {
      try {
        const data = JSON.parse(e.data);
        setProgress({ current: data.total, total: data.total, status: 'Analysis complete!' });
      } catch { /* ignore */ }
      finish();
    });

    es.addEventListener('error', (e) => {
      if (closed) return;
      try {
        const data = JSON.parse(e.data);
        notify(data.message || 'Analysis error', 'error');
      } catch {
        // SSE connection error (not a custom error event)
        if (!analyzingRef.current) return;
        notify('Connection lost during analysis', 'error');
      }
      finish();
    });
  };

  const cancelAnalysis = () => {
    eventSourceRef.current?.close();
    setAnalyzing(false);
    analyzingRef.current = false;
    setProgress(prev => prev ? { ...prev, status: 'Cancelled' } : null);
  };

  // ─── Checkbox management ──────────────────────────────
  const toggleAtom = (key) => {
    setCheckedAtoms(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const selectAll = () => setCheckedAtoms(new Set(allAtomKeys));
  const deselectAll = () => setCheckedAtoms(new Set());

  // ─── Save ─────────────────────────────────────────────
  const handleSave = async () => {
    if (checkedCount === 0) return;
    setSaving(true);
    try {
      const atoms = [];
      results.forEach((post, pi) => {
        post.atoms.forEach((atom, ai) => {
          if (checkedAtoms.has(`${pi}-${ai}`)) {
            atoms.push({ category: atom.category, text: atom.text, tags: atom.tags || [] });
          }
        });
      });
      await analyzerApi.save({
        profileUsername: username.trim(),
        atoms,
        analyzedPostCount: results.length,
      });
      notify(`Saved ${atoms.length} atoms to Style Library`, 'success');
      // Refresh profiles list
      libraryApi.profiles().then(setProfiles).catch(() => {});
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteProfile = async (profileUsername) => {
    try {
      await libraryApi.removeBySource(profileUsername);
      setProfiles(prev => prev.filter(p => p.username !== profileUsername));
      notify(`Removed all atoms from @${profileUsername}`, 'success');
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  const handleReanalyze = useCallback((profileUsername) => {
    setUsername(profileUsername);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    notify(`Username set to @${profileUsername} — click Analyze to start`, 'info');
  }, [notify]);

  const handleViewAtoms = useCallback((profileUsername) => {
    navigateTo('styleLibrary', { usernameFilter: profileUsername });
  }, [navigateTo]);

  // ─── Render ───────────────────────────────────────────
  return (
    <div className="space-y-6 animate-in">
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gradient">Profile Analyzer</h1>

      {/* Input Section */}
      <Card>
        <div className="flex gap-3 items-end flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <Input
              label="Instagram Username"
              placeholder="username (without @)"
              value={username}
              onChange={e => setUsername(e.target.value)}
            />
          </div>
          <div className="w-24">
            <Input
              label="Posts"
              type="number"
              min={1}
              max={30}
              value={postLimit}
              onChange={e => setPostLimit(parseInt(e.target.value) || 12)}
            />
          </div>
          <div className="w-32">
            <Select
              label="Order"
              value={sort}
              onChange={e => setSort(e.target.value)}
              options={[
                { value: 'newest', label: 'Newest first' },
                { value: 'oldest', label: 'Oldest first' },
              ]}
            />
          </div>
          <div className="w-36">
            <Input
              label="Newer than"
              placeholder="e.g. 30 days"
              value={newerThan}
              onChange={e => setNewerThan(e.target.value)}
            />
          </div>
          {analyzing ? (
            <Btn variant="danger" onClick={cancelAnalysis}>Cancel</Btn>
          ) : (
            <Btn variant="primary" onClick={startAnalysis} disabled={!username.trim()}>Analyze</Btn>
          )}
        </div>
        {sort === 'oldest' && (
          <p className="text-[10px] text-zinc-500 mt-2">
            Oldest mode scrapes up to {Math.min(100, postLimit * 8)} posts to find the {postLimit} oldest. This uses more Apify credits.
          </p>
        )}
      </Card>

      {/* Progress */}
      {progress && (
        <Card>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-400">{progress.status}</span>
              {progress.total > 0 && (
                <span className="text-xs text-zinc-500">{progress.current}/{progress.total}</span>
              )}
            </div>
            {progress.total > 0 && (
              <ProgressBar value={Math.round((progress.current / progress.total) * 100)} />
            )}
          </div>
        </Card>
      )}

      {/* Content Patterns */}
      {contentPatterns && <ContentPatternsCard data={contentPatterns} />}

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-300">{results.length} posts analyzed</span>
            <div className="flex gap-2">
              <button onClick={selectAll} className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer">Select All</button>
              <button onClick={deselectAll} className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer">Deselect All</button>
            </div>
          </div>

          {results.map((post, pi) => (
            <Card key={pi}>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-zinc-300">Post {pi + 1}</span>
                  {post.postUrl && (
                    <a
                      href={post.postUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-zinc-500 hover:text-blue-400 truncate max-w-[300px]"
                    >
                      {post.postUrl}
                    </a>
                  )}
                </div>
                <div className="space-y-1">
                  {post.atoms.map((atom, ai) => {
                    const key = `${pi}-${ai}`;
                    return (
                      <label key={key} className="flex items-start gap-2 p-2 rounded-lg bg-zinc-800/40 hover:bg-zinc-800/70 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checkedAtoms.has(key)}
                          onChange={() => toggleAtom(key)}
                          className="mt-0.5 accent-blue-500"
                        />
                        <Badge color={CATEGORY_COLORS[atom.category] || 'zinc'}>{atom.category}</Badge>
                        <p className="flex-1 text-xs text-zinc-300 leading-relaxed">{atom.text}</p>
                      </label>
                    );
                  })}
                  {post.atoms.length === 0 && (
                    <p className="text-xs text-zinc-600 italic">No atoms extracted from this post</p>
                  )}
                </div>
                {post.recommendedPrompt && (
                  <details className="mt-2 group">
                    <summary className="text-[10px] font-medium text-purple-400 cursor-pointer select-none hover:text-purple-300">
                      Suggested Recreation Prompt
                    </summary>
                    <div className="mt-1 p-2 rounded-lg bg-zinc-800/60 border border-zinc-700/50">
                      <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">{post.recommendedPrompt}</p>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(post.recommendedPrompt);
                          notify('Prompt copied to clipboard', 'success');
                        }}
                        className="mt-1 text-[10px] text-blue-400 hover:text-blue-300 cursor-pointer"
                      >
                        Copy
                      </button>
                    </div>
                  </details>
                )}
              </div>
            </Card>
          ))}

          {/* Save bar */}
          <div className="flex items-center justify-between gap-3 pt-2">
            <Btn variant="primary" onClick={handleSave} disabled={saving || checkedCount === 0}>
              {saving ? <><Spinner size={14} /> Saving...</> : `Save ${checkedCount} Selected \u2192 Library`}
            </Btn>
            <Btn variant="ghost" onClick={() => { setResults([]); setCheckedAtoms(new Set()); setProgress(null); }}>
              Discard All
            </Btn>
          </div>
        </div>
      )}

      {/* Empty state (no results, not analyzing) */}
      {!analyzing && results.length === 0 && !progress && (
        <Empty
          icon={'\uD83D\uDD0D'}
          title="Analyze an Instagram profile"
          subtitle="Enter a username to scrape their posts and extract reusable style atoms"
        />
      )}

      {/* Previously Analyzed Profiles */}
      {profiles.length > 0 && (
        <Card>
          <h3 className="text-xs font-medium text-zinc-400 mb-3">Previously Analyzed Profiles</h3>
          <div className="space-y-2">
            {profiles.map(p => (
              <ProfileRow
                key={p.username}
                profile={p}
                onReanalyze={handleReanalyze}
                onViewAtoms={handleViewAtoms}
                onDelete={handleDeleteProfile}
              />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── Profile Row with dropdown ────────────────────────
function ProfileRow({ profile, onReanalyze, onViewAtoms, onDelete }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const p = profile;

  return (
    <div className="flex items-center justify-between p-2 rounded-lg bg-zinc-800/40 group">
      <div>
        <span className="text-sm text-zinc-300">@{p.username}</span>
        <span className="text-xs text-zinc-500 ml-2">{p.atomCount || 0} atoms</span>
      </div>
      <div className="flex gap-2 items-center">
        <span className="text-[10px] text-zinc-600">
          {new Date(p.analyzedAt).toLocaleDateString()}
        </span>
        {/* Dropdown trigger */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setOpen(v => !v)}
            className="p-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 cursor-pointer transition-colors"
            title="Actions"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="8" cy="3" r="1.5" />
              <circle cx="8" cy="8" r="1.5" />
              <circle cx="8" cy="13" r="1.5" />
            </svg>
          </button>
          {open && (
            <div className="absolute right-0 top-full mt-1 z-50 w-44 rounded-lg border border-zinc-700/60 bg-zinc-900 shadow-xl shadow-black/40 py-1 animate-in">
              <button
                onClick={() => { setOpen(false); onReanalyze(p.username); }}
                className="flex items-center gap-2 w-full px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 cursor-pointer transition-colors [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor] [--nc-gradient-2-color-1:currentColor] [--nc-gradient-2-color-2:currentColor] [--nc-light:currentColor]"
              >
                <span className="w-4 flex items-center justify-center opacity-60"><IconArrowsBoldOppositeDirection uniqueId={`profile-reanalyze-${p.username}`} size={16} aria-hidden /></span>
                Re-analyze
              </button>
              <button
                onClick={() => { setOpen(false); onViewAtoms(p.username); }}
                className="flex items-center gap-2 w-full px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 cursor-pointer transition-colors [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor] [--nc-gradient-2-color-1:currentColor] [--nc-gradient-2-color-2:currentColor] [--nc-light:currentColor]"
              >
                <span className="w-4 flex items-center justify-center opacity-60"><IconColorPalette uniqueId={`profile-view-atoms-${p.username}`} size={16} aria-hidden /></span>
                View Atoms
              </button>
              <div className="my-1 h-px bg-zinc-800" />
              <button
                onClick={() => { setOpen(false); onDelete(p.username); }}
                className="flex items-center gap-2 w-full px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300 cursor-pointer transition-colors [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor] [--nc-gradient-2-color-1:currentColor] [--nc-gradient-2-color-2:currentColor] [--nc-light:currentColor]"
              >
                <span className="w-4 flex items-center justify-center opacity-60"><IconDeleteX uniqueId={`profile-delete-${p.username}`} size={16} aria-hidden /></span>
                Delete All Atoms
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Content Patterns Card ────────────────────────────
function ContentPatternsCard({ data }) {
  const { topHashtags, captionStats, engagement, postTypes, schedule } = data;

  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const maxDayCount = Math.max(...(schedule?.dayDistribution?.map(d => d.count) || [1]));

  return (
    <Card>
      <h3 className="text-sm font-semibold text-zinc-200 mb-4">Content Patterns</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Engagement */}
        <div className="space-y-2">
          <p className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">Engagement</p>
          <div className="flex gap-3">
            <StatBox label="Avg Likes" value={engagement?.avgLikes?.toLocaleString() || '—'} />
            <StatBox label="Avg Comments" value={engagement?.avgComments?.toLocaleString() || '—'} />
            <StatBox label="Posts" value={engagement?.totalPosts || '—'} />
          </div>
        </div>

        {/* Caption Stats */}
        <div className="space-y-2">
          <p className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">Captions</p>
          <div className="flex gap-3">
            <StatBox label="Avg Length" value={`${captionStats?.avgLength || 0} chars`} />
            <StatBox label="With #tags" value={`${captionStats?.withHashtags || 0}/${captionStats?.total || 0}`} />
          </div>
        </div>

        {/* Post Types */}
        {postTypes && Object.keys(postTypes).length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">Post Types</p>
            <div className="flex gap-2 flex-wrap">
              {Object.entries(postTypes).map(([type, count]) => (
                <span key={type} className="px-2 py-0.5 text-[10px] rounded-full bg-zinc-800 border border-zinc-700/50 text-zinc-300">
                  {type} <span className="text-zinc-500">{count}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Posting Schedule */}
        <div className="space-y-2">
          <p className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">Schedule</p>
          <div className="flex gap-3">
            {schedule?.avgDaysBetween != null && (
              <StatBox label="Frequency" value={`Every ${schedule.avgDaysBetween}d`} />
            )}
            {schedule?.peakDay && <StatBox label="Peak Day" value={schedule.peakDay} />}
            {schedule?.peakHour != null && (
              <StatBox label="Peak Hour" value={`${schedule.peakHour}:00`} />
            )}
          </div>
          {/* Day-of-week mini bar chart */}
          {schedule?.dayDistribution && (
            <div className="flex items-end gap-1 h-10 mt-1">
              {schedule.dayDistribution.map((d, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                  <div
                    className="w-full rounded-sm bg-blue-500/40"
                    style={{ height: `${Math.max(2, (d.count / maxDayCount) * 28)}px` }}
                    title={`${d.day}: ${d.count} posts`}
                  />
                  <span className="text-[8px] text-zinc-600">{d.day}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top Hashtags */}
        {topHashtags && topHashtags.length > 0 && (
          <div className="md:col-span-2 space-y-2">
            <p className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
              Top Hashtags <span className="text-zinc-600">({topHashtags.length})</span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {topHashtags.map(({ tag, count }) => (
                <span
                  key={tag}
                  className="px-2 py-0.5 text-[10px] rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-300"
                >
                  #{tag} <span className="text-purple-500/60">{count}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function StatBox({ label, value }) {
  return (
    <div className="flex-1 p-2 rounded-lg bg-zinc-800/50 border border-zinc-700/40 text-center">
      <p className="text-sm font-semibold text-zinc-200">{value}</p>
      <p className="text-[9px] text-zinc-500">{label}</p>
    </div>
  );
}

const CATEGORY_COLORS = {
  pose: 'blue', expression: 'green', outfit: 'yellow', scene: 'blue',
  lighting: 'yellow', camera: 'zinc', vibe: 'green', accessories: 'red', format: 'purple',
};
