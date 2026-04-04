import React from 'react';
import NotificationBell from './NotificationBell';

const PLAN_COLORS = { free: '#6b7280', pro: '#6366f1', unlimited: '#f59e0b' };

export default function Navbar({ user, onLogout, onNavigate }) {
  if (!user) return null;
  const plan = user.plan || 'free';
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1.5rem', background: '#111', borderBottom: '1px solid #222', position: 'sticky', top: 0, zIndex: 100 }}>
      <div style={{ color: '#e0e0ff', fontWeight: 700, fontSize: '18px' }}>Kyros Studio</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <span style={{ padding: '0.2rem 0.6rem', borderRadius: '20px', background: PLAN_COLORS[plan] + '33', color: PLAN_COLORS[plan], fontSize: '12px', fontWeight: 600, textTransform: 'uppercase' }}>{plan}</span>
        <span style={{ color: '#a0a0c0', fontSize: '14px' }}>{user.email}</span>
        <NotificationBell />
        {user.isAdmin && <button onClick={() => onNavigate && onNavigate('admin')} style={{ padding: '0.3rem 0.75rem', background: '#1a1a1a', border: '1px solid #444', borderRadius: '6px', color: '#f59e0b', cursor: 'pointer', fontSize: '12px' }}>Admin</button>}
        <button onClick={() => onNavigate && onNavigate('settings')} style={{ padding: '0.3rem 0.75rem', background: '#1a1a1a', border: '1px solid #444', borderRadius: '6px', color: '#a0a0c0', cursor: 'pointer', fontSize: '12px' }}>Settings</button>
        <button onClick={() => onNavigate && onNavigate('billing')} style={{ padding: '0.3rem 0.75rem', background: '#1a1a1a', border: '1px solid #444', borderRadius: '6px', color: '#a0a0c0', cursor: 'pointer', fontSize: '12px' }}>Billing</button>
        <button onClick={onLogout} style={{ padding: '0.3rem 0.75rem', background: '#1a1a1a', border: '1px solid #ef4444', borderRadius: '6px', color: '#ef4444', cursor: 'pointer', fontSize: '12px' }}>Logout</button>
      </div>
    </div>
  );
}
