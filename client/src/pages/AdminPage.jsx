import { useCallback, useEffect, useMemo, useState } from 'react';
import { admin as adminApi } from '../services/api';
import { Badge, Btn, Card, Empty, Input, Modal, Select, Skeleton, Spinner } from '../components/UI';
import { useApp } from '../context/AppContext';

function MetricCard({ label, value, sublabel }) {
  return (
    <Card className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-2xl font-semibold text-zinc-100">{value}</div>
      {sublabel ? <div className="text-xs text-zinc-500">{sublabel}</div> : null}
    </Card>
  );
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
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

export default function AdminPage() {
  const { notify } = useApp();
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [users, setUsers] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });
  const [auditLogs, setAuditLogs] = useState([]);
  const [query, setQuery] = useState('');
  const [plan, setPlan] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [selectedUser, setSelectedUser] = useState(null);
  const [selectedActivity, setSelectedActivity] = useState([]);
  const [supportNotes, setSupportNotes] = useState([]);
  const [newSupportNote, setNewSupportNote] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [acting, setActing] = useState(false);

  const filters = useMemo(() => ({
    page: pagination.page,
    limit: pagination.limit,
    query,
    plan,
    status,
    role,
  }), [pagination.page, pagination.limit, query, plan, status, role]);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const [overviewData, analyticsData, userData, auditData] = await Promise.all([
        adminApi.overview(),
        adminApi.analytics(14),
        adminApi.users(filters),
        adminApi.auditLogs(20),
      ]);
      setOverview(overviewData);
      setAnalytics(analyticsData);
      setUsers(userData.items || []);
      setPagination(userData.pagination || { page: 1, limit: 20, total: 0, totalPages: 1 });
      setAuditLogs(auditData.items || []);
    } catch (err) {
      notify(err.message || 'Failed to load admin data', 'error');
    } finally {
      setLoading(false);
    }
  }, [filters, notify]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (!selectedUserId) return;
    let cancelled = false;
    setDetailLoading(true);
    Promise.all([adminApi.user(selectedUserId), adminApi.userActivity(selectedUserId), adminApi.userSupportNotes(selectedUserId)])
      .then(([userData, activityData, notesData]) => {
        if (cancelled) return;
        setSelectedUser(userData.user || null);
        setSelectedActivity(activityData.items || []);
        setSupportNotes(notesData.items || []);
      })
      .catch((err) => {
        if (!cancelled) notify(err.message || 'Failed to load user detail', 'error');
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedUserId, notify]);

  async function handleAction(type, extra = {}) {
    if (!selectedUserId || acting) return;
    setActing(true);
    try {
      await adminApi.actOnUser(selectedUserId, { type, ...extra });
      notify('Admin action applied', 'success');
      await Promise.all([
        loadDashboard(),
        adminApi.user(selectedUserId).then((data) => setSelectedUser(data.user || null)),
        adminApi.userActivity(selectedUserId).then((data) => setSelectedActivity(data.items || [])),
        adminApi.userSupportNotes(selectedUserId).then((data) => setSupportNotes(data.items || [])),
      ]);
    } catch (err) {
      notify(err.message || 'Action failed', 'error');
    } finally {
      setActing(false);
    }
  }

  async function handleAddSupportNote() {
    if (!selectedUserId || !newSupportNote.trim() || acting) return;
    setActing(true);
    try {
      await adminApi.addUserSupportNote(selectedUserId, newSupportNote.trim());
      setNewSupportNote('');
      const notesData = await adminApi.userSupportNotes(selectedUserId);
      setSupportNotes(notesData.items || []);
      notify('Support note added', 'success');
      await loadDashboard();
    } catch (err) {
      notify(err.message || 'Failed to add support note', 'error');
    } finally {
      setActing(false);
    }
  }

  const overviewCards = overview ? [
    { label: 'Users', value: overview.totals.users, sublabel: `${overview.totals.verifiedUsers} verified` },
    { label: 'Paid Users', value: overview.totals.paidUsers, sublabel: `${overview.billing.pro || 0} pro / ${overview.billing.unlimited || 0} unlimited` },
    { label: 'Active 24H', value: overview.activity.activeUsers24h, sublabel: `${overview.activity.activeUsers7d} active in 7d` },
    { label: 'Generations 24H', value: overview.activity.generations24h, sublabel: `${overview.activity.generationFailures24h} failed` },
  ] : [];
  const dailyRows = analytics?.daily || [];
  const featureRows = analytics?.featureBreakdown || [];
  const topUserRows = analytics?.topUsers || [];
  const failureRows = analytics?.failureReasons || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Admin Console</h1>
          <p className="text-sm text-zinc-500">Operate the SaaS, inspect users, and review audit history.</p>
        </div>
        <Btn variant="secondary" onClick={loadDashboard} disabled={loading}>Refresh</Btn>
      </div>

      {loading && !overview ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, idx) => <Skeleton key={idx} className="h-28 w-full" />)}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {overviewCards.map((item) => <MetricCard key={item.label} {...item} />)}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-200">14 Day Trend</h2>
            <Badge color="zinc">{analytics?.days || 14} days</Badge>
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
                    <td className="py-2.5 pr-3 text-zinc-400">{row.day}</td>
                    <td className="py-2.5 pr-3">{row.signups}</td>
                    <td className="py-2.5 pr-3">{row.activeUsers}</td>
                    <td className="py-2.5 pr-3">{row.generations}</td>
                    <td className="py-2.5">
                      <span className={row.failures > 0 ? 'text-red-400' : 'text-zinc-400'}>{row.failures}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-200">Revenue Signal</h2>
            <Badge color="green">${analytics?.revenueEstimate?.estimatedMrrUsd || 0} est. MRR</Badge>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-zinc-800/60 p-3">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Activation</div>
              <div className="mt-1 text-lg font-semibold text-zinc-100">{percent(analytics?.funnel?.generatedUsers || 0, analytics?.funnel?.totalUsers || 0)}</div>
              <div className="text-xs text-zinc-500">Generated at least once</div>
            </div>
            <div className="rounded-lg border border-zinc-800/60 p-3">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Login Rate</div>
              <div className="mt-1 text-lg font-semibold text-zinc-100">{percent(analytics?.funnel?.loggedInUsers || 0, analytics?.funnel?.totalUsers || 0)}</div>
              <div className="text-xs text-zinc-500">Signed in at least once</div>
            </div>
            <div className="rounded-lg border border-zinc-800/60 p-3">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Paid Rate</div>
              <div className="mt-1 text-lg font-semibold text-zinc-100">{percent(analytics?.funnel?.paidUsers || 0, analytics?.funnel?.totalUsers || 0)}</div>
              <div className="text-xs text-zinc-500">Current paid conversion</div>
            </div>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Free</span>
              <span className="text-zinc-200">{analytics?.revenueEstimate?.planCounts?.free || 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Pro</span>
              <span className="text-zinc-200">{analytics?.revenueEstimate?.planCounts?.pro || 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Unlimited</span>
              <span className="text-zinc-200">{analytics?.revenueEstimate?.planCounts?.unlimited || 0}</span>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Card className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row">
            <Input
              className="lg:flex-1"
              placeholder="Search by email or name"
              value={query}
              onChange={(e) => {
                setPagination((p) => ({ ...p, page: 1 }));
                setQuery(e.target.value);
              }}
            />
            <Select
              className="lg:w-40"
              value={plan}
              onChange={(e) => {
                setPagination((p) => ({ ...p, page: 1 }));
                setPlan(e.target.value);
              }}
              options={[
                { value: '', label: 'All plans' },
                { value: 'free', label: 'Free' },
                { value: 'pro', label: 'Pro' },
                { value: 'unlimited', label: 'Unlimited' },
              ]}
            />
            <Select
              className="lg:w-40"
              value={status}
              onChange={(e) => {
                setPagination((p) => ({ ...p, page: 1 }));
                setStatus(e.target.value);
              }}
              options={[
                { value: '', label: 'All status' },
                { value: 'active', label: 'Active' },
                { value: 'banned', label: 'Banned' },
                { value: 'verified', label: 'Verified' },
                { value: 'unverified', label: 'Unverified' },
              ]}
            />
            <Select
              className="lg:w-40"
              value={role}
              onChange={(e) => {
                setPagination((p) => ({ ...p, page: 1 }));
                setRole(e.target.value);
              }}
              options={[
                { value: '', label: 'All roles' },
                { value: 'admin', label: 'Admins' },
                { value: 'member', label: 'Members' },
              ]}
            />
          </div>

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
                    className="border-b border-zinc-900/80 text-zinc-300 hover:bg-zinc-900/40 cursor-pointer"
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
                      <div className="flex flex-wrap gap-1.5">
                        {user.is_admin ? <Badge color="yellow">Admin</Badge> : null}
                        {user.is_banned ? <Badge color="red">Banned</Badge> : <Badge color="green">Active</Badge>}
                        {!user.verified ? <Badge color="zinc">Unverified</Badge> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!loading && users.length === 0 ? (
              <Empty icon="user" title="No users match these filters" subtitle="Try broadening the search or removing a filter." />
            ) : null}
          </div>

          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>{pagination.total || 0} total users</span>
            <div className="flex items-center gap-2">
              <Btn
                variant="ghost"
                disabled={pagination.page <= 1 || loading}
                onClick={() => setPagination((p) => ({ ...p, page: Math.max(1, p.page - 1) }))}
              >
                Prev
              </Btn>
              <span>Page {pagination.page} / {pagination.totalPages}</span>
              <Btn
                variant="ghost"
                disabled={pagination.page >= pagination.totalPages || loading}
                onClick={() => setPagination((p) => ({ ...p, page: Math.min(p.totalPages, p.page + 1) }))}
              >
                Next
              </Btn>
            </div>
          </div>
        </Card>

        <div className="space-y-6">
          <Card className="space-y-4">
            <h2 className="text-sm font-semibold text-zinc-200">Feature Mix (30D)</h2>
            {featureRows.length === 0 ? (
              <Empty icon="plan" title="No tracked feature usage yet" subtitle="Feature stats will fill in as more generation events are recorded." />
            ) : (
              <div className="space-y-3">
                {featureRows.map((row) => (
                  <div key={row.feature} className="rounded-lg border border-zinc-800/60 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-zinc-100">{row.feature}</div>
                      <Badge color={row.failedRuns > 0 ? 'yellow' : 'blue'}>{row.totalRuns} runs</Badge>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
                      <span>{row.uniqueUsers} users</span>
                      <span>{row.failedRuns} failures</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-200">Recent Signups</h2>
              {overview ? <Badge color="zinc">{overview.activity.signups24h} in 24h</Badge> : null}
            </div>
            <div className="space-y-3">
              {(overview?.recentSignups || []).map((item) => (
                <div key={item.id} className="rounded-lg border border-zinc-800/60 p-3">
                  <div className="text-sm font-medium text-zinc-100">{item.email}</div>
                  <div className="text-xs text-zinc-500">{item.name || 'No name'} • {formatDate(item.created_at)}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="space-y-4">
            <h2 className="text-sm font-semibold text-zinc-200">Top Active Users (30D)</h2>
            {topUserRows.length === 0 ? (
              <Empty icon="user" title="No active users yet" subtitle="This list fills in once generation runs are tracked." />
            ) : (
              <div className="space-y-3">
                {topUserRows.map((row) => (
                  <div key={row.id} className="rounded-lg border border-zinc-800/60 p-3">
                    <div className="text-sm font-medium text-zinc-100">{row.email}</div>
                    <div className="mt-1 flex items-center justify-between text-xs text-zinc-500">
                      <span>{row.totalRuns} runs</span>
                      <span>{row.failedRuns} failed</span>
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-600">Last run: {formatDate(row.lastRunAt)}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="space-y-4">
            <h2 className="text-sm font-semibold text-zinc-200">Top Failure Codes (30D)</h2>
            {failureRows.length === 0 ? (
              <Empty icon="search" title="No failures recorded" subtitle="Failure groups appear once generation errors are tracked." />
            ) : (
              <div className="space-y-2">
                {failureRows.map((row) => (
                  <div key={row.errorCode} className="flex items-center justify-between rounded-lg border border-zinc-800/60 p-3 text-sm">
                    <span className="font-mono text-zinc-400">{row.errorCode}</span>
                    <Badge color="red">{row.count}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="space-y-4">
            <h2 className="text-sm font-semibold text-zinc-200">Audit Log</h2>
            <div className="space-y-3">
              {auditLogs.length === 0 ? (
                <Empty icon="plan" title="No admin actions yet" subtitle="Audit entries appear when admins change plans, roles, or account state." />
              ) : auditLogs.map((item) => (
                <div key={item.id} className="rounded-lg border border-zinc-800/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-zinc-100">{item.action_type}</div>
                    <div className="text-[11px] text-zinc-500">{formatDate(item.created_at)}</div>
                  </div>
                  <div className="text-xs text-zinc-500 mt-1">
                    {item.admin_email || 'Unknown admin'} → {item.target_email || 'Unknown target'}
                  </div>
                  {item.note ? <div className="text-xs text-zinc-400 mt-2">{item.note}</div> : null}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Modal
        open={!!selectedUserId}
        onClose={() => {
          setSelectedUserId(null);
          setSelectedUser(null);
          setSelectedActivity([]);
          setSupportNotes([]);
          setNewSupportNote('');
        }}
        title={selectedUser?.email || 'User detail'}
        className="max-w-4xl"
      >
        {detailLoading ? (
          <div className="flex items-center justify-center py-16"><Spinner size={32} /></div>
        ) : !selectedUser ? (
          <Empty icon="user" title="User not found" subtitle="The selected account could not be loaded." />
        ) : (
          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard label="Plan" value={selectedUser.subscription?.plan || 'free'} sublabel={selectedUser.subscription?.status || 'active'} />
              <MetricCard label="Connected Keys" value={selectedUser.connected_key_count || 0} sublabel="Stored provider keys" />
              <MetricCard label="Runs Total" value={selectedUser.generation_count_total || 0} sublabel={`${selectedUser.generation_count_30d || 0} in 30d`} />
              <MetricCard label="Last Active" value={selectedUser.last_active_at ? new Date(selectedUser.last_active_at).toLocaleDateString() : 'Never'} sublabel={formatDate(selectedUser.last_active_at)} />
            </div>

            <Card className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Btn
                  variant={selectedUser.is_banned ? 'secondary' : 'danger'}
                  disabled={acting}
                  onClick={() => handleAction(selectedUser.is_banned ? 'unban' : 'ban')}
                >
                  {selectedUser.is_banned ? 'Unban User' : 'Ban User'}
                </Btn>
                <Btn
                  variant="secondary"
                  disabled={acting}
                  onClick={() => handleAction(selectedUser.is_admin ? 'revoke_admin' : 'grant_admin')}
                >
                  {selectedUser.is_admin ? 'Revoke Admin' : 'Grant Admin'}
                </Btn>
                <Btn variant="ghost" disabled={acting} onClick={() => handleAction('change_plan', { plan: 'free' })}>Set Free</Btn>
                <Btn variant="ghost" disabled={acting} onClick={() => handleAction('change_plan', { plan: 'pro' })}>Set Pro</Btn>
                <Btn variant="ghost" disabled={acting} onClick={() => handleAction('change_plan', { plan: 'unlimited' })}>Set Unlimited</Btn>
              </div>
            </Card>

            <div className="grid gap-6 xl:grid-cols-2">
              <Card className="space-y-3">
                <h3 className="text-sm font-semibold text-zinc-200">Generation Mix</h3>
                {selectedUser.generationByFeature?.length ? selectedUser.generationByFeature.map((item) => (
                  <div key={item.feature} className="flex items-center justify-between text-sm">
                    <span className="text-zinc-400">{item.feature}</span>
                    <span className="font-medium text-zinc-200">{item.count}</span>
                  </div>
                )) : <Empty icon="image" title="No generation history yet" subtitle="This user has not created tracked runs." />}
              </Card>

              <Card className="space-y-3">
                <h3 className="text-sm font-semibold text-zinc-200">Recent Billing Rows</h3>
                {selectedUser.billingHistory?.length ? selectedUser.billingHistory.map((item) => (
                  <div key={item.id} className="rounded-lg border border-zinc-800/60 p-3">
                    <div className="flex items-center justify-between">
                      <Badge color={planColor(item.plan)}>{item.plan}</Badge>
                      <span className="text-xs text-zinc-500">{formatDate(item.created_at)}</span>
                    </div>
                    <div className="text-xs text-zinc-400 mt-2">Status: {item.status}{item.expires_at ? ` • Expires ${formatDate(item.expires_at)}` : ''}</div>
                  </div>
                )) : <Empty icon="plan" title="No billing history" subtitle="This account only has the default state so far." />}
              </Card>
            </div>

            <Card className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-zinc-200">Support Notes</h3>
                <a
                  href="https://t.me/contentstudioaiQ"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  Open Telegram Support
                </a>
              </div>
              <div className="space-y-3">
                <textarea
                  value={newSupportNote}
                  onChange={(e) => setNewSupportNote(e.target.value)}
                  placeholder="Leave context for the next admin: bug repro, billing issue, promised follow-up, etc."
                  className="min-h-[96px] w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 placeholder:text-zinc-600"
                />
                <div className="flex justify-end">
                  <Btn onClick={handleAddSupportNote} disabled={acting || !newSupportNote.trim()}>
                    Add Support Note
                  </Btn>
                </div>
              </div>
              {supportNotes.length === 0 ? (
                <Empty icon="plan" title="No support notes yet" subtitle="Use notes to capture promises, edge cases, and follow-up context for this account." />
              ) : (
                <div className="space-y-3">
                  {supportNotes.map((note) => (
                    <div key={note.id} className="rounded-lg border border-zinc-800/60 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs text-zinc-500">{note.admin_email || 'Unknown admin'}</div>
                        <div className="text-[11px] text-zinc-600">{formatDate(note.created_at)}</div>
                      </div>
                      <div className="mt-2 whitespace-pre-wrap text-sm text-zinc-300">{note.body}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-200">Activity Timeline</h3>
              <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                {selectedActivity.length ? selectedActivity.map((item) => (
                  <div key={`${item.type}-${item.id}`} className="rounded-lg border border-zinc-800/60 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-zinc-100">{item.label}</div>
                      <div className="text-[11px] text-zinc-500">{formatDate(item.created_at)}</div>
                    </div>
                    <div className="text-xs text-zinc-500 mt-1">{item.type} • {item.source || 'system'}</div>
                    {item.details ? <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-zinc-950/70 p-2 text-[11px] text-zinc-400">{item.details}</pre> : null}
                  </div>
                )) : <Empty icon="search" title="No tracked activity yet" subtitle="Activity appears once auth, billing, and generation events are recorded." />}
              </div>
            </Card>
          </div>
        )}
      </Modal>
    </div>
  );
}
