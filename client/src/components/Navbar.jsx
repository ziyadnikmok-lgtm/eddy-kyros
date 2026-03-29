import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const PLAN_COLORS = { free: '#6b7280', pro: '#3b82f6', unlimited: '#8b5cf6' };

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  if (!user) return null;

  return (
    <nav style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 24px', height: '56px', background: '#1a1a2e',
      borderBottom: '1px solid #2d2d4e', position: 'sticky', top: 0, zIndex: 100
    }}>
      <Link to="/" style={{ color: '#e0e0ff', fontWeight: 700, fontSize: '18px', textDecoration: 'none' }}>
        AI Content Studio
      </Link>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <span style={{ color: '#a0a0c0', fontSize: '14px' }}>{user.email}</span>
        <span style={{
          background: PLAN_COLORS[user.plan] || '#6b7280',
          color: '#fff', padding: '2px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 600,
          textTransform: 'uppercase'
        }}>{user.plan || 'free'}</span>
        <Link to="/dashboard/billing" style={{ color: '#a0a0c0', fontSize: '14px', textDecoration: 'none' }}>Billing</Link>
        <Link to="/dashboard/settings" style={{ color: '#a0a0c0', fontSize: '14px', textDecoration: 'none' }}>API Keys</Link>
        {user.isAdmin && <Link to="/admin" style={{ color: '#f59e0b', fontSize: '14px', textDecoration: 'none' }}>Admin</Link>}
        <button onClick={handleLogout} style={{
          background: 'none', border: '1px solid #4a4a6a', color: '#a0a0c0',
          padding: '4px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px'
        }}>Sign out</button>
      </div>
    </nav>
  );
}
