import { useCallback, useEffect, useMemo, useState } from 'react';
import { admin as adminApi } from '../services/api';
import { Badge, Btn, Card, Empty, Input, Modal, Select, Skeleton, Spinner } from '../components/UI';
import { useApp } from '../context/AppContext';

// ── Helpers ────────────────────────────────────────────────────────────────────

function MetricCard({ label, value, sublabel, accent }) {
  return (
    <Card className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`text-2xl font-semibold ${accent || 'text-zinc-100'}`}>{value ?? '—'}</div>
      {sublabel ? <div className="text-xs text-zinc-500">{sublabel}</div> : null}
    </Card>
  );
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function formatDateShort(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

function planColor(plan) {
  if (plan === 'unlimited') return 'yellow';
  if (plan === 'pro') return 'blue';
  return 'zinc';
}

function percent(part, whole) {
  if (!whole) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

function pct(part, whole) {
  if (!whole || !part) return 0;
  return Math.round((part / whole) * 100);
}

function BarCell({ value, max, color = 'bg-blue-500' }) {
  const w = max ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 rounded-full bg-zinc-800 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${w}%` }} />
      </div>
      <span className="text-xs text-zinc-300 tabular-nums w-6 text-right">{value}</span>
    </div>
  );
}

// ── Tabs ───────────────────────────────────────────────────────────────────────

const TABS = ['Overview', 'Analytics', 'Users', 'System'];

function TabBar({ active, onChange }) {
  return (
    <div className="flex gap-1 rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-1">
      {TABS.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            active === t
              ? 'bg-zinc-800 text-zinc-100 shadow'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

// ── Overview tab ───────────────────────────────────────────────────────────────

function OverviewTab({ overview, analytics, auditLogs, loading }) {
  const dailyRows = analytics?.daily || [];
  const featureRows = analytics?.featureBreakdown || [];
  const topUserRows = analytics?.topUsers || [];
  const failureRows = analytics?.failureReasons || [];

  const maxRuns = Math.max(...dailyRows.map((r) => r.generations), 1);

  return (
    <div className="space-y-6">
      {loading && !overview ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Total Users" value={overview?.totals?.users ?? 0} sublabel={`${overview?.totals?.verifiedUsers ?? 0} verified`} />
          <MetricCard label="Paid Users" value={overview?.totals?.paidUsers ?? 0} sublabel={`${overview?.billing?.pro ?? 0} pro · ${overview?.billing?.unlimited ?? 0} unlimited`} accent="text-green-400" />
          <MetricCard label="Active 24h" value={overview?.activity?.activeUsers24h ?? 0} sublabel={`${overview?.activity?.activeUsers7d ?? 0} in last 7 days`} />
          <MetricCard label="Generations 24h" value={overview?.activity?.generations24h ?? 0} sublabel={`${overview?.activity?.generationFailures24h ?? 0} failed`} accent={overview?.activity?.generationFailures24h > 0 ? 'text-red-400' : 'text-zinc-100'} />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]">
        {/* 14-day trend with mini bar chart */}
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-200">14-Day Generation Trend</h2>
            <Badge color="zinc">{analytics?.days ?? 14}d</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-zinc-500">
                <tr className="border-b border-zinc-800/60">
                  <th className="py-2.5 pr-3 font-medium">Day</th>
                  <th className="py-2.5 pr-3 font-medium">Signups</th>
                  <th className="py-2.5 pr-3 font-medium">Active</th>
                  <th className="py-2.5 pr-3 font-medium">Runs</th>
                  <th className="py-2.5 font-medium">Failures</th>
                </tr>
              </thead>
              <tbody>
                {dailyRows.map((row) => (
                  <tr key={row.day} className="border-b border-zinc-900/80 text-zinc-300">
                    <td className="py-2 pr-3 text-xs text-zinc-400">{row.day}</td>
                    <td className="py-2 pr-3">{row.signups}</td>
                    <td className="py-2 pr-3">{row.activeUsers}</td>
                    <td className="py-2 pr-3"><BarCell value={row.generations} max={maxRuns} /></td>
                    <td className="py-2">
                      <span className={row.failures > 0 ? 'text-red-400' : 'text-zinc-500'}>{row.failures}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {dailyRows.length === 0 && <Empty icon="plan" title="No trend data yet" subtitle="Data will appear as generation runs are tracked." />}
          </div>
        </Card>

        {/* Revenue + funnel */}
        <Card className="space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-200">Revenue Signal</h2>
            <Badge color="green">${analytics?.revenueEstimate?.estimatedMrrUsd?.toFixed(0) ?? 0} est. MRR</Badge>
          </div>
          <div className="grid gap-3 grid-cols-3">
            {[
              { label: 'Activation', value: percent(analytics?.funnel?.generatedUsers ?? 0, analytics?.funnel?.totalUsers ?? 0), sub: 'Generated once' },
              { label: 'Login Rate', value: percent(analytics?.funnel?.loggedInUsers ?? 0, analytics?.funnel?.totalUsers ?? 0), sub: 'Logged in once' },
              { label: 'Paid Rate', value: percent(analytics?.funnel?.paidUsers ?? 0, analytics?.funnel?.totalUsers ?? 0), sub: 'Current paid' },
            ].map((m) => (
              <div key={m.label} className="rounded-lg border border-zinc-800/60 p-3">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">{m.label}</div>
                <div className="mt-1 text-xl font-bold text-zinc-100">{m.value}</div>
                <div className="text-[11px] text-zinc-500">{m.sub}</div>
              </div>
            ))}
          </div>
          <div className="space-y-2 text-sm">
            {['free', 'pro', 'unlimited'].map((plan) => (
              <div key={plan} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge color={planColor(plan)}>{plan}</Badge>
                </div>
                <span className="text-zinc-200">{analytics?.revenueEstimate?.planCounts?.[plan] ?? 0} users</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="space-y-4">
          <h2 className="text-sm font-semibold text-zinc-200">Feature Mix (30D)</h2>
          {featureRows.length === 0 ? <Empty icon="plan" title="No usage yet" subtitle="" /> : (
            <div className="space-y-2">
              {featureRows.map((row) => {
                const failRate = row.totalRuns ? Math.round((row.failedRuns / row.totalRuns) * 100) : 0;
                return (
                  <div key={row.feature} className="rounded-lg border border-zinc-800/60 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-zinc-100">{row.feature}</span>
                      <Badge color={failRate > 10 ? 'red' : failRate > 0 ? 'yellow' : 'blue'}>{row.totalRuns}</Badge>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-xs text-zinc-500">
                      <span>{row.uniqueUsers} users</span>
                      <span className={failRate > 10 ? 'text-red-400' : ''}>{failRate}% fail</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-200">Recent Signups</h2>
            <Badge color="zinc">{overview?.activity?.signups24h ?? 0} today</Badge>
          </div>
          <div className="space-y-2">
            {(overview?.recentSignups || []).map((item) => (
              <div key={item.id} className="rounded-lg border border-zinc-800/60 px-3 py-2.5">
                <div className="text-sm font-medium text-zinc-100 truncate">{item.email}</div>
                <div className="text-xs text-zinc-500">{formatDateShort(item.created_at)}</div>
              </div>
            ))}
            {!overview?.recentSignups?.length && <Empty icon="user" title="No recent signups" subtitle="" />}
          </div>
        </Card>

        <Card className="space-y-4">
          <h2 className="text-sm font-semibold text-zinc-200">Top Failure Codes (30D)</h2>
          {failureRows.length === 0 ? <Empty icon="search" title="No failures recorded" subtitle="" /> : (
            <div className="space-y-2">
              {failureRows.map((row) => (
                <div key={row.errorCode} className="flex items-center justify-between rounded-lg border border-zinc-800/60 px-3 py-2.5 text-sm">
                  <span className="font-mono text-zinc-400 text-xs">{row.errorCode}</span>
                  <Badge color="red">{row.count}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold text-zinc-200">Audit Log</h2>
        <div className="space-y-2">
          {auditLogs.length === 0 ? <Empty icon="plan" title="No admin actions yet" subtitle="Audit entries appear as admins take actions." /> : auditLogs.map((item) => (
            <div key={item.id} className="rounded-lg border border-zinc-800/60 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-zinc-100">{item.action_type}</span>
                <span className="text-[11px] text-zinc-500">{formatDate(item.created_at)}</span>
              </div>
              <div className="text-xs text-zinc-500 mt-0.5">
                {item.admin_email || '?'} → {item.target_email || '?'}
              </div>
              {item.note ? <div className="text-xs text-zinc-400 mt-1.5 italic">{item.note}</div> : null}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ── Analytics tab ──────────────────────────────────────────────────────────────

function AnalyticsTab() {
  const [retention, setRetention] = useState(null);
  const [featureTrend, setFeatureTrend] = useState(null);
  const [signups, setSignups] = useState(null);
  const [loading, setLoading] = useState(true);
  const { notify } = useApp();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([adminApi.retention(), adminApi.featureTrend(), adminApi.signupsByDay()])
      .then(([r, f, s]) => {
        if (cancelled) return;
        setRetention(r.cohorts || []);
        setFeatureTrend(f.rows || []);
        setSignups(s.rows || []);
      })
      .catch((err) => notify(err.message || 'Analytics load failed', 'error'))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [notify]);

  if (loading) return <div className="flex justify-center py-24"><Spinner size={32} /></div>;

  // Build feature trend pivot: days × features
  const featureDays = [...new Set((featureTrend || []).map((r) => r.day))].sort();
  const featureNames = [...new Set((featureTrend || []).map((r) => r.feature))];
  const featureMap = {};
  for (const r of (featureTrend || [])) {
    if (!featureMap[r.day]) featureMap[r.day] = {};
    featureMap[r.day][r.feature] = r.runs;
  }

  const maxSignups = Math.max(...(signups || []).map((r) => r.signups), 1);

  return (
    <div className="space-y-6">
      {/* Signup trend */}
      <Card className="space-y-4">
        <h2 className="text-sm font-semibold text-zinc-200">Signup Trend (30D)</h2>
        {!signups?.length ? <Empty icon="user" title="No signup data" subtitle="" /> : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-zinc-500">
                <tr className="border-b border-zinc-800/60">
                  <th className="py-2.5 pr-4 font-medium">Day</th>
                  <th className="py-2.5 pr-4 font-medium">Signups</th>
                  <th className="py-2.5 font-medium">Verified</th>
                </tr>
              </thead>
              <tbody>
                {signups.map((row) => (
                  <tr key={row.day} className="border-b border-zinc-900/80 text-zinc-300">
                    <td className="py-2 pr-4 text-xs text-zinc-400">{row.day}</td>
                    <td className="py-2 pr-4"><BarCell value={row.signups} max={maxSignups} color="bg-green-500" /></td>
                    <td className="py-2 text-xs text-zinc-400">{row.verified}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Retention cohort grid */}
      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">User Retention Cohorts (8 Weeks)</h2>
          <p className="text-xs text-zinc-500 mt-1">% of users from each signup week still active in weeks W0–W4</p>
        </div>
        {!retention?.length ? <Empty icon="plan" title="Not enough data yet" subtitle="Cohort data fills in as users sign up and return." /> : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-zinc-500">
                <tr className="border-b border-zinc-800/60">
                  <th className="py-2.5 pr-4 font-medium">Cohort</th>
                  <th className="py-2.5 pr-3 font-medium">Size</th>
                  {['W0', 'W1', 'W2', 'W3', 'W4'].map((w) => (
                    <th key={w} className="py-2.5 pr-3 font-medium text-center">{w}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {retention.map((row) => {
                  const sz = row.cohort_size || 1;
                  const cells = [row.w0, row.w1, row.w2, row.w3, row.w4];
                  return (
                    <tr key={row.cohort_week} className="border-b border-zinc-900/80 text-zinc-300">
                      <td className="py-2.5 pr-4 text-xs text-zinc-400 font-mono">{row.cohort_week}</td>
                      <td className="py-2.5 pr-3 text-zinc-200">{sz}</td>
                      {cells.map((val, i) => {
                        const p = pct(val, sz);
                        const bg = p >= 40 ? 'bg-green-900/60 text-green-300' : p >= 20 ? 'bg-yellow-900/50 text-yellow-300' : p > 0 ? 'bg-zinc-800/60 text-zinc-300' : 'text-zinc-600';
                        return (
                          <td key={i} className="py-2.5 pr-3 text-center">
                            <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium tabular-nums ${bg}`}>
                              {val > 0 ? `${p}%` : '—'}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Feature trend heatmap */}
      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">Feature Usage Heatmap (14D)</h2>
          <p className="text-xs text-zinc-500 mt-1">Daily generation runs per feature</p>
        </div>
        {!featureDays.length ? <Empty icon="plan" title="No feature data" subtitle="" /> : (
          <div className="overflow-x-auto">
            <table className="min-w-max text-xs">
              <thead className="text-zinc-500">
                <tr className="border-b border-zinc-800/60">
                  <th className="py-2 pr-3 text-left font-medium">Feature</th>
                  {featureDays.map((d) => (
                    <th key={d} className="py-2 px-1.5 font-medium text-center text-[10px]">{d.slice(5)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {featureNames.map((feat) => {
                  const maxVal = Math.max(...featureDays.map((d) => featureMap[d]?.[feat] || 0), 1);
                  return (
                    <tr key={feat} className="border-b border-zinc-900/80">
                      <td className="py-2 pr-3 text-zinc-300 font-medium whitespace-nowrap">{feat}</td>
                      {featureDays.map((d) => {
                        const v = featureMap[d]?.[feat] || 0;
                        const intensity = Math.round((v / maxVal) * 9);
                        const colors = ['bg-zinc-900', 'bg-blue-950', 'bg-blue-900/40', 'bg-blue-800/50', 'bg-blue-700/50', 'bg-blue-600/60', 'bg-blue-500/60', 'bg-blue-400/70', 'bg-blue-300/70', 'bg-blue-200/80'];
                        return (
                          <td key={d} className="py-1 px-1.5">
                            <div
                              className={`w-8 h-6 rounded text-center leading-6 text-[10px] font-medium ${colors[intensity] || 'bg-zinc-900'} ${v > 0 ? 'text-zinc-200' : 'text-zinc-700'}`}
                              title={`${feat} on ${d}: ${v} runs`}
                            >
                              {v > 0 ? v : ''}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Users tab ──────────────────────────────────────────────────────────────────

function UsersTab({ notify }) {
  const [users, setUsers] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 1 });
  const [query, setQuery] = useState('');
  const [plan, setPlan] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [selectedUser, setSelectedUser] = useState(null);
  const [selectedActivity, setSelectedActivity] = useState([]);
  const [supportNotes, setSupportNotes] = useState([]);
  const [newSupportNote, setNewSupportNote] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [resetResult, setResetResult] = useState(null);
  const [lightboxItem, setLightboxItem] = useState(null);
  const [allLibraryItems, setAllLibraryItems] = useState(null);
  const [allLibraryLoading, setAllLibraryLoading] = useState(false);
  const [showAllLibrary, setShowAllLibrary] = useState(false);
  const [msgSubject, setMsgSubject] = useState('');
  const [msgBody, setMsgBody] = useState('');
  const [msgSending, setMsgSending] = useState(false);
  const [sentMessages, setSentMessages] = useState([]);

  const filters = useMemo(() => ({
    page: pagination.page, limit: pagination.limit, query, plan, status, role,
  }), [pagination.page, pagination.limit, query, plan, status, role]);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminApi.users(filters);
      setUsers(data.items || []);
      setPagination(data.pagination || { page: 1, limit: 25, total: 0, totalPages: 1 });
    } catch (err) {
      notify(err.message || 'Failed to load users', 'error');
    } finally {
      setLoading(false);
    }
  }, [filters, notify]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  useEffect(() => {
    if (!selectedUserId) return;
    let cancelled = false;
    setDetailLoading(true);
    setResetResult(null);
    Promise.all([adminApi.user(selectedUserId), adminApi.userActivity(selectedUserId), adminApi.userSupportNotes(selectedUserId), adminApi.getUserMessages(selectedUserId)])
      .then(([ud, ad, nd, md]) => {
        if (cancelled) return;
        setSelectedUser(ud.user || null);
        setSelectedActivity(ad.items || []);
        setSupportNotes(nd.items || []);
        setSentMessages(md.messages || []);
        setAllLibraryItems(null);
        setShowAllLibrary(false);
      })
      .catch((err) => { if (!cancelled) notify(err.message || 'Failed to load user', 'error'); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedUserId, notify]);

  async function handleAction(type, extra = {}) {
    if (!selectedUserId || acting) return;
    setActing(true);
    try {
      await adminApi.actOnUser(selectedUserId, { type, ...extra });
      notify('Action applied', 'success');
      const [ud] = await Promise.all([adminApi.user(selectedUserId), loadUsers()]);
      setSelectedUser(ud.user || null);
    } catch (err) {
      notify(err.message || 'Action failed', 'error');
    } finally {
      setActing(false);
    }
  }

  async function handleForceReset() {
    if (!selectedUserId || acting) return;
    setActing(true);
    try {
      const data = await adminApi.forceReset(selectedUserId);
      setResetResult(data);
      notify('Reset link generated', 'success');
    } catch (err) {
      notify(err.message || 'Failed to generate reset', 'error');
    } finally {
      setActing(false);
    }
  }

  async function handleDelete() {
    if (!selectedUserId || acting) return;
    if (!window.confirm(`Permanently delete this account? This cannot be undone.`)) return;
    setActing(true);
    try {
      await adminApi.deleteUser(selectedUserId, 'Admin-initiated deletion');
      notify('Account deleted', 'success');
      setSelectedUserId(null);
      setSelectedUser(null);
      loadUsers();
    } catch (err) {
      notify(err.message || 'Delete failed', 'error');
    } finally {
      setActing(false);
    }
  }

  async function handleAddNote() {
    if (!selectedUserId || !newSupportNote.trim() || acting) return;
    setActing(true);
    try {
      await adminApi.addUserSupportNote(selectedUserId, newSupportNote.trim());
      setNewSupportNote('');
      const nd = await adminApi.userSupportNotes(selectedUserId);
      setSupportNotes(nd.items || []);
      notify('Note added', 'success');
    } catch (err) {
      notify(err.message || 'Failed to add note', 'error');
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Filters + export */}
      <div className="flex flex-wrap gap-3">
        <Input
          className="flex-1 min-w-[180px]"
          placeholder="Search by email or name"
          value={query}
          onChange={(e) => { setPagination((p) => ({ ...p, page: 1 })); setQuery(e.target.value); }}
        />
        <Select className="w-36" value={plan} onChange={(e) => { setPagination((p) => ({ ...p, page: 1 })); setPlan(e.target.value); }}
          options={[{ value: '', label: 'All plans' }, { value: 'free', label: 'Free' }, { value: 'pro', label: 'Pro' }, { value: 'unlimited', label: 'Unlimited' }]} />
        <Select className="w-36" value={status} onChange={(e) => { setPagination((p) => ({ ...p, page: 1 })); setStatus(e.target.value); }}
          options={[{ value: '', label: 'All status' }, { value: 'active', label: 'Active' }, { value: 'banned', label: 'Banned' }, { value: 'verified', label: 'Verified' }, { value: 'unverified', label: 'Unverified' }]} />
        <Select className="w-36" value={role} onChange={(e) => { setPagination((p) => ({ ...p, page: 1 })); setRole(e.target.value); }}
          options={[{ value: '', label: 'All roles' }, { value: 'admin', label: 'Admins' }, { value: 'member', label: 'Members' }]} />
        <a
          href="/api/admin/users/export.csv"
          download
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700/60 bg-zinc-800/60 px-3 py-2 text-sm font-medium text-zinc-300 hover:text-zinc-100 hover:border-zinc-600 transition-colors"
        >
          Export CSV
        </a>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-zinc-500">
              <tr className="border-b border-zinc-800/60">
                <th className="py-3 pr-3 font-medium">User</th>
                <th className="py-3 pr-3 font-medium">Plan</th>
                <th className="py-3 pr-3 font-medium">Last Active</th>
                <th className="py-3 pr-3 font-medium">30D Runs</th>
                <th className="py-3 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr
                  key={user.id}
                  className="border-b border-zinc-900/80 text-zinc-300 hover:bg-zinc-900/40 cursor-pointer transition-colors"
                  onClick={() => setSelectedUserId(user.id)}
                >
                  <td className="py-3 pr-3">
                    <div className="font-medium text-zinc-100">{user.email}</div>
                    <div className="text-xs text-zinc-500">{user.name || 'No name'}</div>
                  </td>
                  <td className="py-3 pr-3"><Badge color={planColor(user.plan)}>{user.plan || 'free'}</Badge></td>
                  <td className="py-3 pr-3 text-xs text-zinc-400">{formatDate(user.last_active_at)}</td>
                  <td className="py-3 pr-3">{user.generation_count_30d || 0}</td>
                  <td className="py-3">
                    <div className="flex flex-wrap gap-1">
                      {user.is_admin ? <Badge color="yellow">Admin</Badge> : null}
                      {user.is_banned ? <Badge color="red">Banned</Badge> : <Badge color="green">Active</Badge>}
                      {!user.verified ? <Badge color="zinc">Unverified</Badge> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && users.length === 0 && <Empty icon="user" title="No users match these filters" subtitle="Try broadening the search." />}
        </div>

        <div className="flex items-center justify-between pt-4 text-xs text-zinc-500">
          <span>{pagination.total} total users</span>
          <div className="flex items-center gap-2">
            <Btn variant="ghost" disabled={pagination.page <= 1 || loading} onClick={() => setPagination((p) => ({ ...p, page: Math.max(1, p.page - 1) }))}>Prev</Btn>
            <span>Page {pagination.page} / {pagination.totalPages}</span>
            <Btn variant="ghost" disabled={pagination.page >= pagination.totalPages || loading} onClick={() => setPagination((p) => ({ ...p, page: Math.min(p.totalPages, p.page + 1) }))}>Next</Btn>
          </div>
        </div>
      </Card>

      {/* User Detail Modal */}
      <Modal
        open={!!selectedUserId}
        onClose={() => { setSelectedUserId(null); setSelectedUser(null); setSelectedActivity([]); setSupportNotes([]); setNewSupportNote(''); setResetResult(null); setAllLibraryItems(null); setShowAllLibrary(false); setMsgSubject(''); setMsgBody(''); setSentMessages([]); }}
        title={selectedUser?.email || 'User detail'}
        className="max-w-4xl"
      >
        {detailLoading ? (
          <div className="flex justify-center py-16"><Spinner size={32} /></div>
        ) : !selectedUser ? (
          <Empty icon="user" title="User not found" subtitle="" />
        ) : (
          <div className="space-y-6">
            {/* Key stats */}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard label="Plan" value={selectedUser.subscription?.plan || 'free'} sublabel={selectedUser.subscription?.status || 'active'} />
              <MetricCard label="Keys" value={selectedUser.connected_key_count || 0} sublabel="Connected provider keys" />
              <MetricCard label="Total Runs" value={selectedUser.generation_count_total || 0} sublabel={`${selectedUser.generation_count_30d || 0} in 30d`} />
              <MetricCard label="Last Active" value={selectedUser.last_active_at ? formatDateShort(selectedUser.last_active_at) : 'Never'} sublabel={formatDate(selectedUser.last_active_at)} />
            </div>

            {/* Actions */}
            <Card className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-200">Admin Actions</h3>
              <div className="flex flex-wrap gap-2">
                <Btn variant={selectedUser.is_banned ? 'secondary' : 'danger'} disabled={acting} onClick={() => handleAction(selectedUser.is_banned ? 'unban' : 'ban')}>
                  {selectedUser.is_banned ? 'Unban' : 'Ban User'}
                </Btn>
                <Btn variant="secondary" disabled={acting} onClick={() => handleAction(selectedUser.is_admin ? 'revoke_admin' : 'grant_admin')}>
                  {selectedUser.is_admin ? 'Revoke Admin' : 'Grant Admin'}
                </Btn>
                <Btn variant="ghost" disabled={acting} onClick={() => handleAction('change_plan', { plan: 'free' })}>→ Free</Btn>
                <Btn variant="ghost" disabled={acting} onClick={() => handleAction('change_plan', { plan: 'pro' })}>→ Pro</Btn>
                <Btn variant="ghost" disabled={acting} onClick={() => handleAction('change_plan', { plan: 'unlimited' })}>→ Unlimited</Btn>
                <Btn variant="secondary" disabled={acting} onClick={handleForceReset}>Force Password Reset</Btn>
                {!selectedUser.is_admin && (
                  <Btn variant="danger" disabled={acting} onClick={handleDelete}>Delete Account</Btn>
                )}
              </div>
              {resetResult && (
                <div className="rounded-lg border border-yellow-800/60 bg-yellow-900/20 p-3 space-y-1">
                  <div className="text-xs font-semibold text-yellow-300">Password reset link (share with user, expires in 2h):</div>
                  <div className="font-mono text-xs text-yellow-200 break-all select-all">{resetResult.resetLink}</div>
                </div>
              )}
            </Card>

            <div className="grid gap-6 xl:grid-cols-2">
              <Card className="space-y-3">
                <h3 className="text-sm font-semibold text-zinc-200">Generation Mix</h3>
                {selectedUser.generationByFeature?.length ? selectedUser.generationByFeature.map((item) => (
                  <div key={item.feature} className="flex items-center justify-between text-sm">
                    <span className="text-zinc-400">{item.feature}</span>
                    <span className="font-medium text-zinc-200">{item.count}</span>
                  </div>
                )) : <Empty icon="image" title="No generation history" subtitle="" />}
              </Card>

              <Card className="space-y-3">
                <h3 className="text-sm font-semibold text-zinc-200">Billing History</h3>
                {selectedUser.billingHistory?.length ? selectedUser.billingHistory.map((item) => (
                  <div key={item.id} className="rounded-lg border border-zinc-800/60 p-3">
                    <div className="flex items-center justify-between">
                      <Badge color={planColor(item.plan)}>{item.plan}</Badge>
                      <span className="text-xs text-zinc-500">{formatDate(item.created_at)}</span>
                    </div>
                    <div className="text-xs text-zinc-400 mt-1.5">
                      {item.status}{item.heleket_order_id ? ` · ${item.heleket_order_id}` : ''}{item.expires_at ? ` · exp ${formatDateShort(item.expires_at)}` : ''}
                    </div>
                  </div>
                )) : <Empty icon="plan" title="No billing history" subtitle="" />}
              </Card>
            </div>

            <Card className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold text-zinc-200">
                    {selectedUser.recentLibraryMode === 'runs-fallback' ? 'Recent Runs' : 'Recent Library'}
                  </h3>
                  {selectedUser.recentLibraryNote ? (
                    <div className="text-xs text-zinc-500">{selectedUser.recentLibraryNote}</div>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-zinc-500">{selectedUser.recentLibraryItems?.length || 0} shown</span>
                  <Btn variant="secondary" className="!py-1 !px-2.5 !text-xs" onClick={async () => {
                    if (allLibraryItems) { setShowAllLibrary(true); return; }
                    setAllLibraryLoading(true);
                    try {
                      const r = await adminApi.userLibraryAll(selectedUserId);
                      setAllLibraryItems(r.items || []);
                      setShowAllLibrary(true);
                    } catch (e) { notify(e.message || 'Failed', 'error'); }
                    finally { setAllLibraryLoading(false); }
                  }} disabled={allLibraryLoading}>
                    {allLibraryLoading ? <Spinner size={12} /> : `View all`}
                  </Btn>
                </div>
              </div>
              {selectedUser.recentLibraryItems?.length ? (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {selectedUser.recentLibraryItems.map((item) => (
                    <div
                      key={`${item.mediaType}-${item.id}`}
                      className="overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-900/40 cursor-pointer hover:border-zinc-600/60 transition-colors"
                      onClick={() => setLightboxItem(item)}
                    >
                      <div className="aspect-[4/5] bg-zinc-950 flex items-center justify-center overflow-hidden">
                        {item.mediaType === 'image' && item.previewUrl ? (
                          <img src={item.previewUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                        ) : item.mediaType === 'video' && item.previewUrl ? (
                          <video src={item.previewUrl} className="h-full w-full object-cover" muted preload="metadata" />
                        ) : (
                          <div className="space-y-1 px-3 text-center">
                            <div className="text-xs font-medium text-zinc-500">
                              {selectedUser.recentLibraryMode === 'runs-fallback' ? 'Run history only' : 'No preview'}
                            </div>
                            {item.metadata?.model ? (
                              <div className="text-[10px] text-zinc-600 line-clamp-2">{item.metadata.model}</div>
                            ) : null}
                          </div>
                        )}
                      </div>
                      <div className="p-2.5 space-y-1.5">
                        <div className="flex gap-1.5 flex-wrap">
                          <Badge color={item.mediaType === 'image' ? 'blue' : 'purple'}>{item.mediaType}</Badge>
                          {item.source ? <Badge color="zinc">{item.source}</Badge> : null}
                          {item.status ? <Badge color={item.status === 'succeeded' || item.status === 'completed' ? 'green' : item.status === 'failed' ? 'red' : 'yellow'}>{item.status}</Badge> : null}
                        </div>
                        <div className="text-xs text-zinc-400 line-clamp-3">{item.prompt || 'No prompt'}</div>
                        {item.metadata?.outputCount !== undefined || item.metadata?.error ? (
                          <div className="text-[10px] text-zinc-500 line-clamp-2">
                            {item.metadata?.outputCount !== undefined ? `${item.metadata.outputCount} outputs` : ''}
                            {item.metadata?.outputCount !== undefined && item.metadata?.error ? ' · ' : ''}
                            {item.metadata?.error || ''}
                          </div>
                        ) : null}
                        <div className="text-[10px] text-zinc-600">{formatDate(item.createdAt)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : <Empty icon="image" title="No library items" subtitle="" />}

              {/* Image lightbox */}
              {lightboxItem && (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
                  onClick={() => setLightboxItem(null)}
                >
                  <div
                    className="relative bg-zinc-900 border border-zinc-700/60 rounded-2xl overflow-hidden max-w-3xl w-full max-h-[90vh] flex flex-col"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Close */}
                    <button
                      className="absolute top-3 right-3 z-10 rounded-full bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white w-8 h-8 flex items-center justify-center text-lg leading-none transition-colors"
                      onClick={() => setLightboxItem(null)}
                    >×</button>

                    {/* Media */}
                    <div className="bg-zinc-950 flex items-center justify-center overflow-hidden" style={{ maxHeight: '60vh' }}>
                      {lightboxItem.mediaType === 'image' && lightboxItem.previewUrl ? (
                        <img src={lightboxItem.previewUrl} alt="" className="max-h-[60vh] max-w-full object-contain" />
                      ) : lightboxItem.mediaType === 'video' && lightboxItem.previewUrl ? (
                        <video src={lightboxItem.previewUrl} className="max-h-[60vh] max-w-full" controls autoPlay muted />
                      ) : (
                        <div className="py-16 text-zinc-600 text-sm">No preview available</div>
                      )}
                    </div>

                    {/* Prompt + meta */}
                    <div className="p-4 space-y-3 overflow-y-auto">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge color={lightboxItem.mediaType === 'image' ? 'blue' : 'purple'}>{lightboxItem.mediaType}</Badge>
                        {lightboxItem.source ? <Badge color="zinc">{lightboxItem.source}</Badge> : null}
                        {lightboxItem.status ? <Badge color={lightboxItem.status === 'succeeded' || lightboxItem.status === 'completed' ? 'green' : lightboxItem.status === 'failed' ? 'red' : 'yellow'}>{lightboxItem.status}</Badge> : null}
                        <span className="text-[11px] text-zinc-500 ml-auto">{formatDate(lightboxItem.createdAt)}</span>
                      </div>
                      {lightboxItem.prompt ? (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Prompt</span>
                            <Btn
                              variant="secondary"
                              className="!py-1 !px-2.5 !text-xs"
                              onClick={() => {
                                navigator.clipboard.writeText(lightboxItem.prompt).catch(() => {});
                                notify('Prompt copied', 'success');
                              }}
                            >Copy Prompt</Btn>
                          </div>
                          <div className="rounded-lg bg-zinc-950/60 border border-zinc-700/40 px-3 py-2.5 text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                            {lightboxItem.prompt}
                          </div>
                        </div>
                      ) : (
                        <p className="text-xs text-zinc-500">No prompt recorded</p>
                      )}
                      {lightboxItem.metadata?.model ? (
                        <div className="text-[11px] text-zinc-500">Model: <span className="text-zinc-400">{lightboxItem.metadata.model}</span></div>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}

              {/* View all library modal */}
              {showAllLibrary && (
                <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/85 backdrop-blur-sm p-4 overflow-y-auto" onClick={() => setShowAllLibrary(false)}>
                  <div className="relative bg-zinc-900 border border-zinc-700/60 rounded-2xl w-full max-w-6xl mt-8 mb-8" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/60">
                      <span className="font-semibold text-zinc-100">All Images — {selectedUser?.email}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-zinc-500">{allLibraryItems?.length || 0} items</span>
                        <button className="rounded-full bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 w-8 h-8 flex items-center justify-center text-lg transition-colors" onClick={() => setShowAllLibrary(false)}>×</button>
                      </div>
                    </div>
                    <div className="p-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                      {(allLibraryItems || []).map((item) => (
                        <div key={`all-${item.id}`} className="overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-900/40 cursor-pointer hover:border-zinc-600/60 transition-colors" onClick={() => { setShowAllLibrary(false); setLightboxItem(item); }}>
                          <div className="aspect-square bg-zinc-950 flex items-center justify-center overflow-hidden">
                            {item.mediaType === 'image' && item.previewUrl ? (
                              <img src={item.previewUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                            ) : item.mediaType === 'video' && item.previewUrl ? (
                              <video src={item.previewUrl} className="h-full w-full object-cover" muted preload="metadata" />
                            ) : (
                              <div className="text-xs text-zinc-600 px-2 text-center">No preview</div>
                            )}
                          </div>
                          <div className="p-2 space-y-1">
                            <div className="flex gap-1 flex-wrap">
                              <Badge color={item.mediaType === 'image' ? 'blue' : 'purple'}>{item.mediaType}</Badge>
                              {item.source ? <Badge color="zinc">{item.source}</Badge> : null}
                            </div>
                            <div className="text-[10px] text-zinc-500 line-clamp-2">{item.prompt || 'No prompt'}</div>
                            <div className="text-[10px] text-zinc-600">{formatDate(item.createdAt)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </Card>

            {/* ── Send Message to User ── */}
            <Card className="space-y-4">
              <h3 className="text-sm font-semibold text-zinc-200">Send Message to User</h3>
              <p className="text-xs text-zinc-500 -mt-2">The user will see this as a notification when they next open the app.</p>
              <Input
                label="Subject (optional)"
                placeholder="e.g. Welcome to Kyros!"
                value={msgSubject}
                onChange={(e) => setMsgSubject(e.target.value)}
              />
              <div className="space-y-1">
                <label className="block text-xs font-medium text-zinc-400">Message</label>
                <textarea
                  className="w-full rounded-lg border border-zinc-700/60 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none resize-none"
                  rows={3}
                  placeholder="Your message to the user..."
                  value={msgBody}
                  onChange={(e) => setMsgBody(e.target.value)}
                />
              </div>
              <Btn
                disabled={msgSending || !msgBody.trim()}
                onClick={async () => {
                  setMsgSending(true);
                  try {
                    await adminApi.sendMessage(selectedUserId, msgSubject.trim(), msgBody.trim());
                    setMsgSubject(''); setMsgBody('');
                    notify('Message sent', 'success');
                    const md = await adminApi.getUserMessages(selectedUserId);
                    setSentMessages(md.messages || []);
                  } catch (e) { notify(e.message || 'Failed to send', 'error'); }
                  finally { setMsgSending(false); }
                }}
              >{msgSending ? <Spinner size={14} /> : 'Send Message'}</Btn>
              {sentMessages.length > 0 && (
                <div className="space-y-2 pt-1 border-t border-zinc-800/60">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Previously sent</p>
                  {sentMessages.map((m) => (
                    <div key={m.id} className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2 space-y-0.5">
                      {m.subject ? <p className="text-xs font-semibold text-zinc-300">{m.subject}</p> : null}
                      <p className="text-xs text-zinc-400">{m.body}</p>
                      <div className="flex items-center gap-2 text-[10px] text-zinc-600">
                        <span>{formatDate(m.created_at)}</span>
                        {m.read_at ? <span className="text-emerald-600">· Read</span> : <span className="text-amber-600">· Unread</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-zinc-200">Support Notes</h3>
                <a href="https://t.me/Kyros_Studio" target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:text-blue-300">Telegram Support</a>
              </div>
              <textarea
                value={newSupportNote}
                onChange={(e) => setNewSupportNote(e.target.value)}
                placeholder="Leave context for the next admin: bug repro, billing issue, follow-up…"
                className="min-h-[80px] w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 placeholder:text-zinc-600"
              />
              <div className="flex justify-end">
                <Btn onClick={handleAddNote} disabled={acting || !newSupportNote.trim()}>Add Note</Btn>
              </div>
              {supportNotes.length === 0 ? <Empty icon="plan" title="No support notes" subtitle="" /> : (
                <div className="space-y-2">
                  {supportNotes.map((note) => (
                    <div key={note.id} className="rounded-lg border border-zinc-800/60 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-zinc-500">{note.admin_email || '?'}</span>
                        <span className="text-[11px] text-zinc-600">{formatDate(note.created_at)}</span>
                      </div>
                      <div className="mt-1.5 whitespace-pre-wrap text-sm text-zinc-300">{note.body}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-200">Activity Timeline</h3>
              <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                {selectedActivity.length ? selectedActivity.map((item) => (
                  <div key={`${item.type}-${item.id}`} className="rounded-lg border border-zinc-800/60 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-zinc-100">{item.label}</span>
                      <span className="text-[11px] text-zinc-500">{formatDate(item.created_at)}</span>
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">{item.type} · {item.source || 'system'}</div>
                    {item.details ? <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded-md bg-zinc-950/70 p-2 text-[11px] text-zinc-400">{item.details}</pre> : null}
                  </div>
                )) : <Empty icon="search" title="No tracked activity" subtitle="" />}
              </div>
            </Card>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ── System tab ─────────────────────────────────────────────────────────────────

function SystemTab() {
  const [system, setSystem] = useState(null);
  const [loading, setLoading] = useState(true);
  const { notify } = useApp();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminApi.system();
      setSystem(data);
    } catch (err) {
      notify(err.message || 'Failed to load system info', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  if (loading) return <div className="flex justify-center py-24"><Spinner size={32} /></div>;
  if (!system) return <Empty icon="search" title="System data unavailable" subtitle="" />;

  const heapPercent = system.memory?.heapTotalMb ? Math.round((system.memory.heapUsedMb / system.memory.heapTotalMb) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-200">Live Server Health</h2>
        <Btn variant="secondary" onClick={load}>Refresh</Btn>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Uptime" value={formatUptime(system.uptime)} sublabel={system.nodeVersion} />
        <MetricCard label="Heap Used" value={`${system.memory?.heapUsedMb} MB`} sublabel={`${heapPercent}% of ${system.memory?.heapTotalMb} MB`} accent={heapPercent > 80 ? 'text-red-400' : 'text-zinc-100'} />
        <MetricCard label="RSS Memory" value={`${system.memory?.rssMb} MB`} sublabel="Process resident set" />
        <MetricCard label="Environment" value={system.env} sublabel={`Node ${system.nodeVersion}`} />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="space-y-4">
          <h2 className="text-sm font-semibold text-zinc-200">Generation Queue</h2>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Queue Depth', value: system.queue?.queueDepth ?? 0, accent: system.queue?.queueDepth > 20 ? 'text-yellow-400' : '' },
              { label: 'Active Workers', value: system.queue?.activeWorkers ?? 0 },
              { label: 'Running Jobs', value: system.jobs?.running ?? 0 },
              { label: 'Pending Jobs', value: system.jobs?.pending ?? 0 },
            ].map((m) => (
              <div key={m.label} className="rounded-lg border border-zinc-800/60 p-3">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">{m.label}</div>
                <div className={`text-xl font-bold mt-1 ${m.accent || 'text-zinc-100'}`}>{m.value}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="space-y-4">
          <h2 className="text-sm font-semibold text-zinc-200">Activity Snapshot</h2>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Jobs Today', value: system.jobs?.totalToday ?? 0 },
              { label: 'Failed (24h)', value: system.jobs?.failedLast24h ?? 0, accent: system.jobs?.failedLast24h > 0 ? 'text-red-400' : '' },
              { label: 'Active Sessions', value: system.sessions?.active ?? 0 },
              { label: 'New Users Today', value: system.accounts?.newToday ?? 0, accent: 'text-green-400' },
            ].map((m) => (
              <div key={m.label} className="rounded-lg border border-zinc-800/60 p-3">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">{m.label}</div>
                <div className={`text-xl font-bold mt-1 ${m.accent || 'text-zinc-100'}`}>{m.value}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {system.accounts?.lockedOut > 0 && (
        <Card className="border-yellow-800/60 bg-yellow-900/10">
          <div className="flex items-center gap-3">
            <div className="text-yellow-400 text-lg">⚠</div>
            <div>
              <div className="text-sm font-semibold text-yellow-300">{system.accounts.lockedOut} account{system.accounts.lockedOut !== 1 ? 's' : ''} currently locked out</div>
              <div className="text-xs text-yellow-600 mt-0.5">Triggered by too many failed login attempts. Locks expire automatically.</div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Root page ──────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { notify } = useApp();
  const [tab, setTab] = useState('Overview');
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [auditLogs, setAuditLogs] = useState([]);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const [overviewData, analyticsData, auditData] = await Promise.all([
        adminApi.overview(),
        adminApi.analytics(14),
        adminApi.auditLogs(20),
      ]);
      setOverview(overviewData);
      setAnalytics(analyticsData);
      setAuditLogs(auditData.items || []);
    } catch (err) {
      notify(err.message || 'Failed to load admin data', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Admin Console</h1>
          <p className="text-sm text-zinc-500">Operate the platform, inspect users, and review system health.</p>
        </div>
        <Btn variant="secondary" onClick={loadOverview} disabled={loading}>Refresh</Btn>
      </div>

      <TabBar active={tab} onChange={setTab} />

      {tab === 'Overview' && (
        <OverviewTab overview={overview} analytics={analytics} auditLogs={auditLogs} loading={loading} />
      )}
      {tab === 'Analytics' && <AnalyticsTab />}
      {tab === 'Users' && <UsersTab notify={notify} />}
      {tab === 'System' && <SystemTab />}
    </div>
  );
}
