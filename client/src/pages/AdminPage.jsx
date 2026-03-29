import React, { useState, useEffect } from 'react';

const s = {
  container: { padding: '2rem', color: '#e0e0ff' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
  th: { padding: '0.5rem', borderBottom: '1px solid #333', textAlign: 'left', color: '#a0a0c0' },
  td: { padding: '0.5rem', borderBottom: '1px solid #222' },
  btn: { padding: '0.25rem 0.75rem', border: 'none', borderRadius: '4px', color: '#fff', cursor: 'pointer', fontSize: '12px' }
};

export default function AdminPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin/users', { credentials: 'include' }).then(r => r.json()).then(data => { setUsers(Array.isArray(data) ? data : []); setLoading(false); });
  }, []);

  const update = async (id, patch) => {
    await fetch(`/api/admin/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(patch) });
    setUsers(us => us.map(u => u.id === id ? { ...u, ...patch } : u));
  };

  if (loading) return <div style={s.container}>Loading...</div>;

  return (
    <div style={s.container}>
      <h2>Admin — Users ({users.length})</h2>
      <div style={{ overflowX: 'auto' }}>
        <table style={s.table}>
          <thead><tr>{['Email','Name','Plan','Verified','Actions'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr></thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td style={s.td}>{u.email}</td>
                <td style={s.td}>{u.name}</td>
                <td style={s.td}>
                  <select value={u.plan || 'free'} onChange={e => update(u.id, { plan: e.target.value })} style={{ background: '#1a1a1a', color: '#fff', border: '1px solid #444', borderRadius: '4px', padding: '0.2rem' }}>
                    {['free','pro','unlimited'].map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </td>
                <td style={s.td}>{u.verified ? 'Yes' : 'No'}</td>
                <td style={s.td}>
                  <button onClick={() => update(u.id, { is_banned: u.is_banned ? 0 : 1 })} style={{...s.btn, background: u.is_banned ? '#4ade80' : '#7f1d1d', marginRight: '4px'}}>{u.is_banned ? 'Unban' : 'Ban'}</button>
                  <button onClick={() => update(u.id, { is_admin: u.is_admin ? 0 : 1 })} style={{...s.btn, background: '#1a1a1a', border: '1px solid #444', color: '#aaa'}}>{u.is_admin ? 'Revoke Admin' : 'Grant Admin'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
