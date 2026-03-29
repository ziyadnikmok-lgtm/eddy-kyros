import { useState, useEffect } from 'react';
import Navbar from '../components/Navbar';
import { useAuth } from '../context/AuthContext';
import { Navigate } from 'react-router-dom';

export default function AdminPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  if (user && !user.isAdmin) return <Navigate to="/" replace />;

  useEffect(() => {
    fetch('/api/admin/users', { credentials: 'include' })
      .then(r => r.json()).then(d => { setUsers(d); setLoading(false); });
  }, []);

  const patch = async (id, payload) => {
    await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setUsers(prev => prev.map(u => u.id === id ? { ...u, ...payload } : u));
  };

  return (
    <>
      <Navbar />
      <div style={{ maxWidth: '1100px', margin: '40px auto', padding: '0 20px' }}>
        <h1 style={{ color: '#e0e0ff', marginBottom: '24px' }}>Admin Panel</h1>
        {loading ? <p style={{ color: '#a0a0c0' }}>Loading...</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', color: '#a0a0c0', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #2d2d4e' }}>
                  {['Email', 'Name', 'Plan', 'Status', 'Verified', 'Joined', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#6b6b8a', fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} style={{ borderBottom: '1px solid #1e1e3a' }}>
                    <td style={{ padding: '10px 12px' }}>{u.email}</td>
                    <td style={{ padding: '10px 12px' }}>{u.name}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <select value={u.plan || 'free'} onChange={e => patch(u.id, { plan: e.target.value })}
                        style={{ background: '#0f0f1a', color: '#e0e0ff', border: '1px solid #3d3d5e', borderRadius: '6px', padding: '4px 8px' }}>
                        {['free', 'pro', 'unlimited'].map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: '10px 12px', color: u.status === 'active' ? '#4ade80' : '#f87171' }}>{u.status || 'active'}</td>
                    <td style={{ padding: '10px 12px' }}>{u.verified ? '✓' : '✗'}</td>
                    <td style={{ padding: '10px 12px' }}>{new Date(u.created_at).toLocaleDateString()}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <button onClick={() => patch(u.id, { is_banned: u.is_banned ? 0 : 1 })}
                        style={{ background: u.is_banned ? '#065f46' : '#7f1d1d', color: '#fff', border: 'none', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', fontSize: '12px' }}>
                        {u.is_banned ? 'Unban' : 'Ban'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
