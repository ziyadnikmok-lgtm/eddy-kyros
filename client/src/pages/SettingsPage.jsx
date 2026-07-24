import { useState } from 'react';
import { Card, Btn, Spinner } from '../components/UI';

async function api(path, body, method = 'POST') {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function Section({ title, children }) {
  return (
    <Card className="space-y-4 max-w-lg">
      <h3 className="text-base font-semibold text-zinc-200 border-b border-zinc-800/60 pb-3">{title}</h3>
      {children}
    </Card>
  );
}

function Input({ label, ...props }) {
  return (
    <div>
      {label && <label className="block text-xs font-medium text-zinc-400 mb-1.5">{label}</label>}
      <input
        {...props}
        className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-rose-500/70 focus:ring-1 focus:ring-rose-500/20 placeholder:text-zinc-600"
      />
    </div>
  );
}

export default function SettingsPage() {
  // Change password
  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [pwLoading, setPwLoading] = useState(false);
  const [pwMsg, setPwMsg] = useState(null);
  const [pwErr, setPwErr] = useState(null);

  // Delete account
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteErr, setDeleteErr] = useState(null);
  const [showDelete, setShowDelete] = useState(false);

  async function handleChangePassword(e) {
    e.preventDefault();
    setPwErr(null); setPwMsg(null);
    if (pwForm.newPassword !== pwForm.confirmPassword) { setPwErr('New passwords do not match'); return; }
    if (pwForm.newPassword.length < 8) { setPwErr('New password must be at least 8 characters'); return; }
    setPwLoading(true);
    try {
      const data = await api('/api/auth/change-password', {
        currentPassword: pwForm.currentPassword,
        newPassword: pwForm.newPassword,
      });
      setPwMsg(data.message);
      setPwForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setTimeout(() => { window.location.reload(); }, 1500);
    } catch (err) {
      setPwErr(err.message);
    }
    setPwLoading(false);
  }

  async function handleDeleteAccount(e) {
    e.preventDefault();
    setDeleteErr(null);
    if (deleteConfirm !== 'DELETE') { setDeleteErr('Type DELETE to confirm'); return; }
    setDeleteLoading(true);
    try {
      await api('/api/auth/account', { password: deletePassword }, 'DELETE');
      window.location.reload();
    } catch (err) {
      setDeleteErr(err.message);
    }
    setDeleteLoading(false);
  }

  return (
    <div className="space-y-6 animate-in max-w-2xl">
      {/* Change Password */}
      <Section title="Change Password">
        <form onSubmit={handleChangePassword} className="space-y-3">
          <Input label="Current Password" type="password" value={pwForm.currentPassword}
            onChange={e => setPwForm(f => ({ ...f, currentPassword: e.target.value }))} required placeholder="Current password" />
          <Input label="New Password" type="password" value={pwForm.newPassword}
            onChange={e => setPwForm(f => ({ ...f, newPassword: e.target.value }))} required placeholder="At least 8 characters" />
          <Input label="Confirm New Password" type="password" value={pwForm.confirmPassword}
            onChange={e => setPwForm(f => ({ ...f, confirmPassword: e.target.value }))} required placeholder="Repeat new password" />
          {pwErr && <p className="text-sm text-red-400">{pwErr}</p>}
          {pwMsg && <p className="text-sm text-green-400">{pwMsg}</p>}
          <Btn type="submit" disabled={pwLoading} className="w-full">
            {pwLoading ? <><Spinner size={16} /> Changing...</> : 'Change Password'}
          </Btn>
        </form>
      </Section>

      {/* Danger Zone */}
      <Card className="border-red-900/40 max-w-lg">
        <h3 className="text-base font-semibold text-red-400 border-b border-red-900/30 pb-3 mb-4">Danger Zone</h3>
        {!showDelete ? (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-300">Delete Account</p>
              <p className="text-xs text-zinc-500 mt-0.5">Permanently delete your account and all data. Cannot be undone.</p>
            </div>
            <button
              onClick={() => setShowDelete(true)}
              className="rounded-lg px-4 py-2 text-sm font-semibold border border-red-800/60 text-red-400 hover:bg-red-900/20 transition cursor-pointer"
            >
              Delete
            </button>
          </div>
        ) : (
          <form onSubmit={handleDeleteAccount} className="space-y-3">
            <p className="text-sm text-zinc-400">Enter your password and type <span className="font-mono font-bold text-red-400">DELETE</span> to confirm.</p>
            <Input label="Password" type="password" value={deletePassword}
              onChange={e => setDeletePassword(e.target.value)} required placeholder="Your password" />
            <Input label='Type "DELETE" to confirm' type="text" value={deleteConfirm}
              onChange={e => setDeleteConfirm(e.target.value)} required placeholder="DELETE" />
            {deleteErr && <p className="text-sm text-red-400">{deleteErr}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowDelete(false)}
                className="flex-1 rounded-lg px-3 py-2 text-sm border border-zinc-700/60 text-zinc-400 hover:bg-zinc-800 transition cursor-pointer">
                Cancel
              </button>
              <button type="submit" disabled={deleteLoading}
                className="flex-1 rounded-lg px-3 py-2 text-sm font-semibold bg-red-900/40 border border-red-700/60 text-red-300 hover:bg-red-900/60 transition cursor-pointer disabled:opacity-50">
                {deleteLoading ? 'Deleting...' : 'Delete My Account'}
              </button>
            </div>
          </form>
        )}
      </Card>

      <Section title="Support">
        <div className="space-y-3">
          <p className="text-sm text-zinc-400">
            Need help with your account, billing, or generation issues? Join the support group and share screenshots or error details.
          </p>
          <a
            href="https://t.me/Kyros_Studio"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center rounded-lg bg-rose-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-rose-500 transition"
          >
            Open Telegram Support
          </a>
        </div>
      </Section>
    </div>
  );
}
