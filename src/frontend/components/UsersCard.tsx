import React, { useState, useEffect, useCallback } from 'react';
import { Modal } from './Modal';
import { url } from '../base-path';
import { API } from '../api-paths';
import type { ManagedUser, AllowedDir, DirAccess } from '../types';
import { DataTable } from './DataTable';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const ROLES: ManagedUser['role'][] = ['chat', 'control', 'admin'];

interface DirEditorProps {
  dirs: AllowedDir[];
  onChange: (dirs: AllowedDir[]) => void;
}

/** Editable list of allowed directories: [path][read/rw][remove] rows */
const DirEditor: React.FC<DirEditorProps> = ({ dirs, onChange }) => {
  return (
    <div className="users-dirs">
      <DataTable
        columns={[
          { key: 'path', label: 'Path' },
          { key: 'access', label: 'Access' },
          { key: 'remove', label: '' },
        ]}
      >
        {dirs.map((d, i) => (
          <tr className="users-dir-row" key={i}>
            <td data-label="Path">
              <input
                className="settings-input users-dir-path"
                type="text"
                placeholder="/absolute/path"
                value={d.path}
                onChange={(e) => {
                  const next = dirs.slice();
                  next[i] = { ...d, path: e.target.value };
                  onChange(next);
                }}
              />
            </td>
            <td data-label="Access">
              <select
                className="settings-input users-dir-access"
                value={d.access}
                onChange={(e) => {
                  const next = dirs.slice();
                  next[i] = { ...d, access: e.target.value as DirAccess };
                  onChange(next);
                }}
              >
                <option value="read">read</option>
                <option value="rw">read/write</option>
              </select>
            </td>
            <td data-label="">
              <button
                type="button"
                className="btn btn-danger btn-row users-dir-remove"
                title="Remove directory"
                onClick={() => onChange(dirs.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </td>
          </tr>
        ))}
      </DataTable>
      <button
        type="button"
        className="btn btn-row users-dir-add"
        onClick={() => onChange([...dirs, { path: '', access: 'read' }])}
      >
        + Add directory
      </button>
    </div>
  );
};

interface UserFormProps {
  initial?: ManagedUser | null;
  /** Own account cannot be demoted/deleted by itself — backend also guards */
  selfUsername: string;
  onSave: (u: any, isNew: boolean) => Promise<string | null>;
  onClose: () => void;
}

/** Create/edit user modal */
const UserForm: React.FC<UserFormProps> = ({ initial, selfUsername, onSave, onClose }) => {
  const isNew = !initial;
  const [username, setUsername] = useState(initial?.username || '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<ManagedUser['role']>(initial?.role || 'chat');
  const [mustChange, setMustChange] = useState(initial ? initial.mustChangePassword : true);
  const [dirs, setDirs] = useState<AllowedDir[]>(initial?.allowedDirs || []);
  const [mountDockerSocket, setMountDockerSocket] = useState(initial?.mountDockerSocket || false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const err = await onSave({
        username: username.trim(),
        ...(isNew || password ? { password } : {}),
        role,
        allowedDirs: dirs.filter((d) => d.path.trim()),
        mustChangePassword: mustChange,
        ...(selfUsername !== username.trim() || role === 'admin' ? { mountDockerSocket } : {}),
      }, isNew);
      if (err) setError(err);
      else onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={true} onClose={onClose} className="modal-users">
      <div className="modal-header">
        <h3>{isNew ? 'Add user' : `Edit ${initial!.username}`}</h3>
        <button className="modal-close" onClick={onClose}>✕</button>
      </div>
      <form className="modal-body users-form" onSubmit={submit}>
        <label className="users-field">
          <span>Username</span>
          <input
            className="settings-input"
            type="text"
            value={username}
            disabled={!isNew}
            autoComplete="off"
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="users-field">
          <span>{isNew ? 'Initial password' : 'New password (leave empty to keep current)'}</span>
          <input
            className="settings-input"
            type="password"
            value={password}
            autoComplete="new-password"
            placeholder={isNew ? '' : 'unchanged'}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="users-field">
          <span>Role</span>
          <select
            className="settings-input"
            value={role}
            disabled={!isNew && initial!.username === selfUsername}
            onChange={(e) => setRole(e.target.value as ManagedUser['role'])}
          >
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        {!isNew && (
          <label className="users-field users-field-inline">
            <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />
            <span>Must change password at next login</span>
          </label>
        )}
        {isNew && (
          <div className="settings-description">The user must change their password at first login.</div>
        )}
        <label className="users-field users-field-inline">
          <input type="checkbox" checked={mountDockerSocket} onChange={(e) => setMountDockerSocket(e.target.checked)} />
          <span>Allow sandboxed sessions to mount the host docker.sock</span>
        </label>
        {mountDockerSocket && (
          <div className="settings-description users-sock-warning">
            ⚠ Security risk: the docker socket grants root-equivalent host access (any container can mount the host filesystem). Grant only to users you fully trust.
          </div>
        )}
        <div className="users-field">
          <span>Workdirs</span>
          <div className="settings-description">
            Absolute paths the user's agent may access; read/write includes write access. Per-directory.
          </div>
          <DirEditor dirs={dirs} onChange={setDirs} />
        </div>
        <div className={`login-error${error ? ' visible' : ''}`}>{error}</div>
        <div className="btn-group">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create user' : 'Save'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
};

export const UsersCard: React.FC<{ username: string | null }> = ({ username }) => {
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const res = await fetch(url(API.users.list));
      const data = await res.json();
      if (data.success) setUsers(data.data || []);
      else setError(data.error || 'Failed to load users');
    } catch {
      setError('Failed to load users');
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const save = useCallback(async (u: any, isNew: boolean): Promise<string | null> => {
    try {
      const res = await fetch(url(isNew ? API.users.list : API.users.item(u.username)), {
        method: isNew ? 'POST' : 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(u),
      });
      const data = await res.json();
      if (!data.success) return data.error || 'Failed to save user';
      await reload();
      return null;
    } catch {
      return 'Failed to save user';
    }
  }, [reload]);

  const remove = useCallback(async (name: string) => {
    if (!confirm(`Delete user "${name}"? Their sessions will be stopped.`)) return;
    try {
      const res = await fetch(url(API.users.item(name)), { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) setError(data.error || 'Failed to delete user');
      else await reload();
    } catch {
      setError('Failed to delete user');
    }
  }, [reload]);

  return (
    <div className="card users-card">
      <div className="card-header">
        <div className="card-title">Users</div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>Add user</button>
      </div>
      {error && !users && <div className="users-error">{error}</div>}
      {!users && !error && <div className="users-loading">Loading…</div>}
      {users && (
        <DataTable
          className="users-table"
          columns={[
            { key: 'user', label: 'User' },
            { key: 'role', label: 'Role' },
            { key: 'dirs', label: 'Dirs' },
            { key: 'flags', label: '' },
            { key: 'actions', label: '' },
          ]}
        >
          {users.map((u) => (
            <tr className="users-row" key={u.username}>
              <td data-label="User">
                <span className="users-name" title={u.username}>
                  {u.username}
                  {u.mustChangePassword && <span className="users-flag" title="Must change password at next login">PW</span>}
                </span>
              </td>
              <td data-label="Role">
                <span className={`users-role users-role-${u.role}`}>{u.role}</span>
              </td>
              <td data-label="Dirs">
                <span className="users-dirs-count" title={u.allowedDirs.map((d) => `${d.path} (${d.access})`).join('\n')}>
                  {u.allowedDirs.length} dir{u.allowedDirs.length === 1 ? '' : 's'}
                </span>
              </td>
              <td data-label="Flags">
                {u.mountDockerSocket && <span className="users-flag" title="May mount the host docker.sock in sandboxes">DOCKER</span>}
              </td>
              <td data-label="Actions" className="data-table-actions">
                <button className="btn btn-row" onClick={() => setEditing(u)}>Edit</button>
                <button
                  className="btn btn-danger btn-row"
                  disabled={u.username === username}
                  title={u.username === username ? 'You cannot delete your own account' : 'Delete user'}
                  onClick={() => remove(u.username)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      {(creating || editing) && (
        <UserForm
          initial={editing}
          selfUsername={username || ''}
          onSave={save}
          onClose={() => { setCreating(false); setEditing(null); setError(''); }}
        />
      )}
    </div>
  );
};