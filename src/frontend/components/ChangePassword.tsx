import React, { useState } from 'react';
import { url } from '../base-path';
import { API } from '../api-paths';

interface ChangePasswordProps {
  username: string | null;
  onSuccess: () => void;
  onLogout?: () => void;
}

/** Full-screen forced password change (first login / admin reset). */
export const ChangePasswordScreen: React.FC<ChangePasswordProps> = ({ username, onSuccess, onLogout }) => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (next !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(url(API.auth.changePassword), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword: current, newPassword: next }),
      });
      const data = await res.json();
      if (data.success) {
        onSuccess();
      } else {
        setError(data.error || 'Failed to change password');
      }
    } catch {
      setError('Connection error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen open">
      <div className="login-form-container">
        <h2 className="login-title">Change password</h2>
        <div className="settings-description users-change-note">
          {username ? `Welcome, ${username}. ` : ''}Set a new password before continuing.
        </div>
        <form onSubmit={submit}>
          <input
            className="login-input"
            type="password"
            placeholder="Current password"
            autoComplete="current-password"
            value={current}
            autoFocus
            onChange={(e) => setCurrent(e.target.value)}
          />
          <input
            className="login-input"
            type="password"
            placeholder="New password (min 8 chars)"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <input
            className="login-input"
            type="password"
            placeholder="Repeat new password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <div className={`login-error${error ? ' visible' : ''}`}>{error}</div>
          <button type="submit" className="login-btn" disabled={busy}>
            {busy ? 'Saving…' : 'Set password'}
          </button>
          {onLogout && (
            <button type="button" className="login-btn users-change-logout" onClick={onLogout}>
              Logout
            </button>
          )}
        </form>
      </div>
    </div>
  );
};