import React, { useState } from 'react';
import { API } from '../../shared/api-paths';
import { url } from '../base-path';
import { THEMES, applyTheme, activeTheme, type ThemeId } from '../theme';

/**
 * Self-service card for non-admin users: change their UI theme and their
 * own password. Nothing else is self-changeable — roles/dirs stay admin-only.
 */
export function UserCard({ username }: { username: string | null }) {
  const [theme, setTheme] = useState<ThemeId>(activeTheme());
  const [themeMsg, setThemeMsg] = useState('');
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwMsg, setPwMsg] = useState('');

  const changeTheme = async (id: ThemeId) => {
    setTheme(id);
    applyTheme(id); // immediate visual feedback
    try {
      const res = await fetch(url(API.auth.theme), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: id }),
      });
      const data = await res.json();
      setThemeMsg(data.success ? '' : data.error || 'Theme save failed');
    } catch {
      setThemeMsg('Theme save failed');
    }
  };

  const changePassword = async () => {
    setPwMsg('');
    if (newPw !== confirm) { setPwMsg('Passwords do not match'); return; }
    try {
      const res = await fetch(url(API.auth.changePassword), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
      });
      const data = await res.json();
      if (data.success) {
        setPwMsg('Password updated');
        setOldPw(''); setNewPw(''); setConfirm('');
      } else {
        setPwMsg(data.error || 'Password change failed');
      }
    } catch {
      setPwMsg('Password change failed');
    }
  };

  const pwField = (label: string, value: string, set: (v: string) => void) => (
    <div className="settings-field">
      <div className="settings-field-header">
        <label className="settings-label">{label}</label>
      </div>
      <input type="password" className="settings-input" value={value} onChange={(e) => set(e.target.value)} autoComplete="new-password" />
    </div>
  );

  return (
    <div className="card user-card">
      <div className="card-header">
        <span className="card-title">User</span>
        <span className="user-card-name">{username ?? '—'}</span>
      </div>
      <div className="settings-content">
        <div className="settings-section">
          <div className="settings-section-head"><h3 className="settings-section-title">Appearance</h3></div>
          <div className="settings-section-fields">
            <div className="settings-field">
              <div className="settings-field-header">
                <label className="settings-label">Theme</label>
              </div>
              <div className="settings-description">Select theme, applies to all clients</div>
              <select className="settings-input" value={theme} onChange={(e) => void changeTheme(e.target.value as ThemeId)}>
                {THEMES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            {themeMsg && <div className="user-card-msg">{themeMsg}</div>}
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-section-head"><h3 className="settings-section-title">Password</h3></div>
          <div className="settings-section-fields">
            {pwField('Current password', oldPw, setOldPw)}
            {pwField('New password', newPw, setNewPw)}
            {pwField('Confirm new password', confirm, setConfirm)}
            <div className="btn-row-wrap">
              <button className="btn btn-primary btn-row" onClick={() => void changePassword()} disabled={!oldPw || !newPw || !confirm}>Save password</button>
            </div>
            {pwMsg && <div className="user-card-msg">{pwMsg}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
