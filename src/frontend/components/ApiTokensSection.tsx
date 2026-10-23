import React, { useState, useEffect, useCallback } from 'react';
import { API } from '../api-paths';
import { DataTable } from './DataTable';
import { apiJSON, apiSend } from '../api';

interface ApiToken {
  id: string;
  name: string;
  createdAt?: number;
  expiry: number;
  prefix: string;
}

/**
 * Settings → API tokens: create/revoke named long-lived tokens for
 * non-browser clients (TUI, scripts). The full token is shown ONCE at
 * creation — the backend only ever returns its prefix afterwards.
 */
export const ApiTokensSection: React.FC = () => {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setTokens(await apiJSON<any[]>(API.tokens.list) || []);
    } catch (err: any) {
      setError(`Failed to load tokens: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setError(null);
    try {
      const created = await apiSend<{ token: string }>(API.tokens.list, 'POST', { name: n });
      setCreated(created.token);
      setName('');
      await load();
    } catch (err) {
      setError(`Failed to create token: ${err}`);
    }
  };

  const remove = async (id: string) => {
    try {
      await apiSend(API.tokens.item(id), 'DELETE');
      await load();
    } catch (err: any) {
      setError(`Failed to delete token: ${err.message}`);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be denied — the token stays visible for manual copy
    }
  };

  return (
    <div className="settings-section">
      <div className="settings-section-head"><h3 className="settings-section-title">API Tokens</h3></div>
      {error && <div className="settings-error">{error}</div>}

      {created && (
        <div className="settings-field api-token-created">
          <label className="settings-label">New token — copy it now, it will not be shown again</label>
          <div className="api-token-created-row">
            <code className="api-token-value">{created}</code>
            <button className="btn btn-primary" type="button" onClick={copy}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      <div className="settings-field">
        <label className="settings-label">Create token</label>
        <div className="settings-description">
          Long-lived tokens for API clients (e.g. the TUI). Authenticates with{' '}
          <code>Authorization: Bearer &lt;token&gt;</code>. The full token is shown only once — copy it immediately.
        </div>
        <div className="sortable-list-add">
          <input
            className="sortable-list-input"
            type="text"
            value={name}
            spellCheck={false}
            placeholder="Token name (e.g. “TUI laptop”)…"
            maxLength={60}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } }}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn btn-primary sortable-list-add-btn" type="button" disabled={!name.trim()} onClick={create}>
            Create
          </button>
        </div>
      </div>

      {loading ? (
        <div className="settings-loading">Loading…</div>
      ) : tokens.length === 0 ? (
        <div className="settings-empty">No API tokens.</div>
      ) : (
        <DataTable
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'prefix', label: 'Prefix' },
            { key: 'created', label: 'Created' },
            { key: 'remove', label: '' },
          ]}
        >
          {tokens.map((t) => (
            <tr key={t.id} className="api-token-row">
              <td data-label="Name"><span className="api-token-name">{t.name}</span></td>
              <td data-label="Prefix"><code>{t.prefix}</code></td>
              <td data-label="Created">{t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '—'}</td>
              <td data-label="">
                <button className="btn btn-danger btn-sm" type="button" onClick={() => remove(t.id)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
};
