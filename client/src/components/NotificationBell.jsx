import { useEffect, useRef, useState } from 'react';
import { batch as batchApi, notifications as notificationsApi } from '../services/api';
import { useApp } from '../context/AppContext';

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export default function NotificationBell() {
  const { notify, navigateTo } = useApp();
  const [notifications, setNotifications] = useState([]);
  const [adminMessages, setAdminMessages] = useState([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef(null);
  const esRef = useRef(null);

  // Load batch notifications + admin messages on mount
  useEffect(() => {
    batchApi.notifications()
      .then((data) => { setNotifications(data.data || []); setUnread((u) => u + (data.unread || 0)); })
      .catch(() => {});
    notificationsApi.list()
      .then((data) => {
        setAdminMessages(data.messages || []);
        setUnread((u) => u + (data.unread || 0));
      })
      .catch(() => {});
  }, []);

  // SSE stream for live batch notifications
  useEffect(() => {
    let es;
    try {
      es = batchApi.notificationStream();
      esRef.current = es;

      es.addEventListener('notification', (e) => {
        try {
          const n = JSON.parse(e.data);
          setNotifications((prev) => [{ ...n, id: `${Date.now()}`, readAt: null, createdAt: new Date().toISOString() }, ...prev].slice(0, 50));
          setUnread((u) => u + 1);
          notify(n.message || 'Batch complete', n.status === 'failed' ? 'error' : 'success', 6000);
        } catch {}
      });

      es.addEventListener('backlog', (e) => {
        try {
          const items = JSON.parse(e.data);
          if (items?.length) {
            setNotifications((prev) => {
              const ids = new Set(prev.map((x) => x.id));
              return [...items.filter((x) => !ids.has(x.id)), ...prev].slice(0, 50);
            });
            setUnread((u) => u + items.length);
          }
        } catch {}
      });
    } catch {}

    return () => { try { es?.close(); } catch {} };
  }, [notify]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function onOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [open]);

  async function handleOpen() {
    setOpen((v) => !v);
    if (!open && unread > 0) {
      setUnread(0);
      setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() })));
      setAdminMessages((prev) => prev.map((m) => ({ ...m, read_at: m.read_at || new Date().toISOString() })));
      batchApi.markNotificationsRead().catch(() => {});
      notificationsApi.readAll().catch(() => {});
    }
  }

  async function handleClear() {
    setNotifications([]);
    setUnread(0);
    batchApi.clearNotifications().catch(() => {});
  }

  const totalCount = notifications.length + adminMessages.length;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={handleOpen}
        className="relative flex items-center justify-center w-9 h-9 rounded-lg border border-zinc-700/60 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
        aria-label="Notifications"
      >
        {/* Bell icon */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 flex items-center justify-center w-4 h-4 rounded-full bg-blue-500 text-[9px] font-bold text-white leading-none">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 rounded-xl border border-zinc-800/80 bg-zinc-900 shadow-2xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/60">
            <span className="text-sm font-semibold text-zinc-200">Notifications</span>
            {notifications.length > 0 && (
              <button onClick={handleClear} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Clear batch</button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {totalCount === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-zinc-600">No notifications yet</div>
            ) : (
              <>
                {/* Admin messages — shown first, styled differently */}
                {adminMessages.map((m) => (
                  <div
                    key={`msg-${m.id}`}
                    className={`px-4 py-3 border-b border-zinc-800/40 ${!m.read_at ? 'bg-blue-950/20' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-400">From Kyros Team</span>
                          {!m.read_at && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />}
                        </div>
                        {m.subject ? <p className="text-sm font-medium text-zinc-100">{m.subject}</p> : null}
                        <p className="text-sm text-zinc-300 leading-relaxed">{m.body}</p>
                      </div>
                    </div>
                    <div className="text-xs text-zinc-600 mt-1">{timeAgo(m.created_at)}</div>
                  </div>
                ))}

                {/* Batch notifications */}
                {notifications.map((n) => (
                  <div
                    key={n.id}
                    onClick={() => { setOpen(false); navigateTo('gallery'); }}
                    className={`px-4 py-3 border-b border-zinc-800/40 cursor-pointer hover:bg-zinc-800/40 transition-colors ${!n.readAt ? 'bg-zinc-800/20' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm text-zinc-200 flex-1">{n.message}</span>
                      {!n.readAt && <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />}
                    </div>
                    <div className="text-xs text-zinc-600 mt-1">{timeAgo(n.createdAt)}</div>
                  </div>
                ))}
              </>
            )}
          </div>

          {notifications.length > 0 && (
            <div className="px-4 py-2.5 border-t border-zinc-800/60">
              <button
                onClick={() => { setOpen(false); navigateTo('gallery'); }}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                Open Gallery →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
