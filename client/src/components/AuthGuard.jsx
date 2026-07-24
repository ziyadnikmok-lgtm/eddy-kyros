import React from 'react';

export default function AuthGuard({ user, loading, children, onNavigate }) {
  if (loading) return <div style={{ color: '#a0a0c0', padding: '2rem', textAlign: 'center' }}>Loading...</div>;
  if (!user) {
    if (onNavigate) onNavigate('login');
    return null;
  }
  return children;
}
