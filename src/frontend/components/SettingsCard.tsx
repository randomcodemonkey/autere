import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SortableList } from './SortableList';
import { PersonasSettingsSection } from './Personas';
import { ApiTokensSection } from './ApiTokensSection';
import { NotificationsSection } from './NotificationsSection';
import { Modal } from './Modal';
import { API } from '../api-paths';
import type { SettingSection, SettingField } from '../types';
import { apiJSON, apiSend, apiBody, JSON_HEADERS } from '../api';

interface FolderIgnoreEntry { path: string; edits: boolean; files: boolean }

interface SettingsCardProps {
  sseConnected: boolean;
  onSessionTabLimitChange?: (limit: number) => void;
}

const normalizeSessionTabLimit = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.max(1, Math.min(20, Math.floor(parsed))) : 8;
};

// Module-level ON PURPOSE: a component type defined inside the render
// function is a NEW type every render, so React remounts the whole subtree —
// every wrapped input lost focus on any re-render (SSE events included),
// making text fields unusable. Hoisted = stable type = DOM preserved.
const FieldShell: React.FC<{ field: SettingField; children: React.ReactNode }> = ({ field, children }) => (
  <div className="settings-field">
    <label className="settings-label">{field.label}</label>
    {field.description && <div className="settings-description">{field.description}</div>}
    {children}
  </div>
);

type McpServerEditDraft = {
  name: string;
  type: 'stdio' | 'http';
  command: string;
  args: string;
  url: string;
  headers: string;
  exposure: string;
  description: string;
  enabled: boolean;
};

const makeMcpServerDraft = (name: string, server: Record<string, any> = {}): McpServerEditDraft => ({
  name,
  type: server.command !== undefined ? 'stdio' : 'http',
  command: server.command || '',
  args: Array.isArray(server.args) ? server.args.join(', ') : '',
  url: server.url || '',
  headers: Object.entries(server.headers || {}).map(([key, value]) => `${key}: ${value}`).join('\n'),
  exposure: server.exposure || 'codemode',
  description: server.description || '',
  enabled: server.enabled !== false,
});

const parseMcpHeaders = (text: string): Record<string, string> | undefined => {
  const entries = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const colon = line.indexOf(':');
      return colon < 0 ? null : [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    })
    .filter((entry): entry is [string, string] => entry !== null && entry[0] !== '');
  return entries.length ? Object.fromEntries(entries) : undefined;
};

const McpServersSection: React.FC<{ field: SettingField; value: unknown; onChange: (key: string, v: Record<string, any>) => void }> = ({ field, value, onChange }) => {
  const servers: Record<string, any> = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
  const names = Object.keys(servers);
  const [editing, setEditing] = useState<{ originalName: string | null; draft: McpServerEditDraft; error: string } | null>(null);

  const openAdd = () => {
    let index = 1;
    while (servers[`server-${index}`]) index++;
    setEditing({ originalName: null, draft: makeMcpServerDraft(`server-${index}`, { command: '', args: [] }), error: '' });
  };
  const openEdit = (name: string) => setEditing({ originalName: name, draft: makeMcpServerDraft(name, servers[name]), error: '' });
  const updateDraft = (changes: Partial<McpServerEditDraft>) => setEditing((current) => current
    ? { ...current, draft: { ...current.draft, ...changes }, error: '' }
    : current);
  const save = () => {
    if (!editing) return;
    const name = editing.draft.name.trim();
    if (!/^[\w-]+$/.test(name)) {
      setEditing({ ...editing, error: 'Use letters, numbers, underscores, or hyphens for the server name.' });
      return;
    }
    if (names.some((existing) => existing !== editing.originalName && existing.toLowerCase() === name.toLowerCase())) {
      setEditing({ ...editing, error: 'A server with that name already exists.' });
      return;
    }

    const server = { ...(editing.originalName ? servers[editing.originalName] : {}) };
    if (editing.draft.exposure !== (server.exposure || 'codemode')) server.exposure = editing.draft.exposure;
    if (editing.draft.description !== (server.description || '')) server.description = editing.draft.description || undefined;
    if (editing.draft.enabled !== (server.enabled !== false)) server.enabled = editing.draft.enabled;
    if (editing.draft.type === 'stdio') {
      server.command = editing.draft.command;
      server.args = editing.draft.args.split(',').map((arg) => arg.trim()).filter(Boolean);
      delete server.url;
      delete server.headers;
    } else {
      server.url = editing.draft.url;
      server.headers = parseMcpHeaders(editing.draft.headers);
      delete server.command;
      delete server.args;
    }

    const next = { ...servers };
    if (editing.originalName) delete next[editing.originalName];
    next[name] = server;
    onChange(field.key, next);
    setEditing(null);
  };
  const remove = (name: string) => {
    const next = { ...servers };
    delete next[name];
    onChange(field.key, next);
  };

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-section-title">{field.label}</h3>
        <button className="btn btn-primary btn-row mcp-add-btn" type="button" onClick={openAdd}>
          Add MCP Server
        </button>
      </div>
      {field.description && <div className="settings-description">{field.description}</div>}
      {names.length === 0 ? (
        <div className="mcp-empty">No MCP servers configured.</div>
      ) : (
        <div className="table-responsive mcp-table-wrap">
          <table className="data-table mcp-table">
            <thead>
              <tr><th>Server</th><th>Type</th><th>Endpoint</th><th>Exposure</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {names.map((name) => {
                const server = servers[name] || {};
                const isStdio = server.command !== undefined;
                const endpoint = isStdio ? [server.command, ...(Array.isArray(server.args) ? server.args : [])].filter(Boolean).join(' ') : server.url;
                return (
                  <tr key={name}>
                    <td data-label="Server"><div className="mcp-server-summary"><strong className="mcp-server-name">{name}</strong>{server.description && <span className="mcp-server-description">{server.description}</span>}</div></td>
                    <td data-label="Type">{isStdio ? 'stdio' : 'HTTP'}</td>
                    <td data-label="Endpoint"><code className="mcp-endpoint">{endpoint || '—'}</code></td>
                    <td data-label="Exposure">{server.exposure || 'codemode'}</td>
                    <td data-label="Status">{server.enabled === false ? 'Disabled' : 'Enabled'}</td>
                    <td data-label="Actions" className="data-table-actions">
                      <button className="btn btn-default mcp-edit" type="button" onClick={() => openEdit(name)}>Edit</button>
                      <button className="btn btn-danger mcp-remove" type="button" onClick={() => remove(name)} title={`Remove ${name}`}>Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Modal open onClose={() => setEditing(null)} className="modal-mcp">
          <div className="modal-header">
            <h3>{editing.originalName ? `Edit MCP server: ${editing.originalName}` : 'Add MCP server'}</h3>
            <button className="modal-close" type="button" onClick={() => setEditing(null)}>✕</button>
          </div>
          <div className="modal-body mcp-edit-form">
            {editing.error && <div className="settings-error">{editing.error}</div>}
            <label className="mcp-edit-field">
              <span>Name</span>
              <input className="settings-input mcp-name" value={editing.draft.name} onChange={(e) => updateDraft({ name: e.target.value })} />
            </label>
            <label className="mcp-edit-field">
              <span>Type</span>
              <select className="settings-input mcp-kind" value={editing.draft.type} onChange={(e) => updateDraft({ type: e.target.value as 'stdio' | 'http' })}>
                <option value="stdio">stdio</option>
                <option value="http">HTTP</option>
              </select>
            </label>
            {editing.draft.type === 'stdio' ? (
              <>
                <label className="mcp-edit-field">
                  <span>Command</span>
                  <input className="settings-input mcp-command" value={editing.draft.command} placeholder="npx -y @modelcontextprotocol/server-everything" onChange={(e) => updateDraft({ command: e.target.value })} />
                </label>
                <label className="mcp-edit-field">
                  <span>Arguments (comma separated)</span>
                  <input className="settings-input mcp-args" value={editing.draft.args} placeholder="-y, @modelcontextprotocol/server-everything" onChange={(e) => updateDraft({ args: e.target.value })} />
                </label>
              </>
            ) : (
              <>
                <label className="mcp-edit-field">
                  <span>URL</span>
                  <input className="settings-input mcp-command" value={editing.draft.url} placeholder="https://example.com/mcp" onChange={(e) => updateDraft({ url: e.target.value })} />
                </label>
                <label className="mcp-edit-field">
                  <span>HTTP headers</span>
                  <span className="settings-description">One per line: Name: value</span>
                  <textarea className="settings-input mcp-headers-editor" rows={5} value={editing.draft.headers} placeholder={'Authorization: Bearer token\nX-Custom: value'} onChange={(e) => updateDraft({ headers: e.target.value })} />
                </label>
              </>
            )}
            <label className="mcp-edit-field">
              <span>Exposure</span>
              <select className="settings-input mcp-exposure" value={editing.draft.exposure} onChange={(e) => updateDraft({ exposure: e.target.value })}>
                <option value="codemode">codemode</option>
                <option value="deferred">deferred (tool search)</option>
                <option value="direct">direct</option>
              </select>
            </label>
            <label className="mcp-edit-field">
              <span>Description</span>
              <textarea className="settings-input" rows={2} value={editing.draft.description} placeholder="What this server offers" onChange={(e) => updateDraft({ description: e.target.value })} />
            </label>
            <label className="mcp-edit-enabled">
              <input type="checkbox" checked={editing.draft.enabled} onChange={(e) => updateDraft({ enabled: e.target.checked })} />
              <span>Enabled</span>
            </label>
            <div className="mcp-modal-actions">
              <button className="btn btn-default" type="button" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" type="button" onClick={save}>Save server</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

// "Add folder" input row: enter a path, then submit — no phantom empty row.
// Duplicate paths are rejected (the backend also dedupes).
const FolderIgnoreAdd: React.FC<{ onAdd: (path: string) => void; items: FolderIgnoreEntry[] }> = ({ onAdd, items }) => {
  const [path, setPath] = useState('');
  const submit = () => {
    const p = path.trim().replace(/\/+$/, '');
    if (!p || items.some((it) => it.path === p)) return;
    onAdd(p);
    setPath('');
  };
  return (
    <div className="sortable-list-add">
      <input
        className="sortable-list-input"
        type="text"
        value={path}
        spellCheck={false}
        placeholder="Add folder…"
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        onChange={(e) => setPath(e.target.value)}
      />
      <button className="btn btn-primary sortable-list-add-btn" type="button" disabled={!path.trim()} onClick={submit}>
        Add folder
      </button>
    </div>
  );
};

/** Models settings section: a table of ALL models pi reports (auto-loaded on
 *  open; the Update button re-reads) with per-model enabled / thinking level /
 *  reserved context / image mode. The enabled checkbox toggles the enabled
 *  list (enabled-first preserves its ordering); all edits go through the SAME
 *  draft settings keys the schema fields use — one Save path, unchanged. */
const ModelsSection: React.FC<{
  section?: SettingSection;
  settings: Record<string, any>;
  catalog: { provider: string; id: string; name: string }[] | null;
  modelsLoading: boolean;
  modelsError: string | null;
  loadCatalog(): void;
  handleChange(key: string, value: any): void;
}> = ({ section, settings, catalog, modelsLoading, modelsError, loadCatalog, handleChange }) => {
  if (!section) return null;
  const thinkingField = section.fields.find((f) => f.key === 'modelThinkingLevels');
  const visionField = section.fields.find((f) => f.key === 'visionByModel');
  const enabled: string[] = Array.isArray(settings.enabledModels) ? settings.enabledModels : [];
  const modelKey = (m: { provider: string; id: string }) => (m.provider ? `${m.provider}/${m.id}` : m.id);
  // Enabled rows keep their priority order; the rest alphabetical.
  const rows = catalog
    ? [
        ...enabled.map((k) => catalog.find((m) => modelKey(m) === k)).filter((m): m is { provider: string; id: string; name: string } => Boolean(m)),
        ...catalog.filter((m) => !enabled.includes(modelKey(m))).sort((a, b) => a.name.localeCompare(b.name)).map((m) => m as { provider: string; id: string; name: string }),
      ]
    : [];
  const mapVal = (fieldKey: string, k: string): any => {
    const v = settings[fieldKey];
    return v && typeof v === 'object' ? v[k] : undefined;
  };
  const setMapEntry = (fieldKey: string, k: string, v: any) => {
    const map: Record<string, any> = { ...(settings[fieldKey] && typeof settings[fieldKey] === 'object' ? settings[fieldKey] : {}) };
    // '' clears the entry → the row falls back to the field's default
    if (v === '' || v === undefined) delete map[k];
    else map[k] = v;
    handleChange(fieldKey, map);
  };
  const toggleEnabled = (k: string, on: boolean) => {
    handleChange('enabledModels', on ? [...enabled, k] : enabled.filter((e) => e !== k));
  };
  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-section-title">{section.label}</h3>
        <button className="btn btn-primary btn-row models-update-btn" type="button" disabled={modelsLoading} onClick={loadCatalog}>
          {modelsLoading ? 'Updating models…' : 'Update available models'}
        </button>
      </div>
      <div className="settings-section-fields">
        {catalog === null && (
          <div className="settings-description">{modelsLoading ? 'Loading models from pi…' : 'Update loads the model catalog from pi.'}</div>
        )}
        <div className="settings-field">
          <div className="settings-description">
            Per-model values apply to ENABLED models; saving restarts the agent.
          </div>
          {modelsError && <div className="settings-description">{modelsError}</div>}
          {catalog !== null && (
            rows.length === 0 ? (
              <div className="settings-description">No models reported by pi.</div>
            ) : (
              <table className="data-table models-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Enabled</th>
                    <th>Thinking level</th>
                    <th>Reserved context</th>
                    <th>Image mode</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => {
                    const k = modelKey(m);
                    const on = enabled.includes(k);
                    return (
                      <tr key={k} className={on ? 'enabled' : ''}>
                        <td className="models-table-name" title={k} data-label="Model">{m.name}</td>
                        <td data-label="Enabled"><input type="checkbox" checked={on} onChange={(e) => toggleEnabled(k, e.target.checked)} /></td>
                        <td data-label="Thinking level">
                          <select
                            className="settings-input"
                            value={String(mapVal('modelThinkingLevels', k) ?? '')}
                            onChange={(e) => setMapEntry('modelThinkingLevels', k, e.target.value)}
                          >
                            {(thinkingField?.perModel?.options || []).map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        </td>
                        <td data-label="Reserved context">
                          <input
                            type="number"
                            className="settings-input"
                            min={0}
                            max={90}
                            placeholder="default"
                            value={String(mapVal('reserveTokensPercentByModel', k) ?? '')}
                            onChange={(e) => setMapEntry('reserveTokensPercentByModel', k, e.target.value === '' ? '' : Number(e.target.value))}
                          />
                        </td>
                        <td data-label="Image mode">
                          <select
                            className="settings-input"
                            value={String(mapVal('visionByModel', k) ?? '')}
                            onChange={(e) => setMapEntry('visionByModel', k, e.target.value)}
                          >
                            {(visionField?.perModel?.options || []).map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          )}
        </div>      </div>
    </div>
  );
};

export const SettingsCard: React.FC<SettingsCardProps> = ({ sseConnected, onSessionTabLimitChange }) => {
  const [schema, setSchema] = useState<SettingSection[]>([]);
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Model catalog for the Models section table — POST /models/available asks
  // pi what it can actually reach. null = not loaded yet; the section
  // auto-loads it on first open, Update re-reads it.
  const [catalog, setCatalog] = useState<{ provider: string; id: string; name: string }[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const loadCatalog = useCallback(async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      setCatalog(await apiSend<{ provider: string; id: string; name: string }[]>(API.modelsCatalog, 'POST'));
    } catch (err: any) {
      setModelsError(err.message || 'Failed to load models from pi');
    } finally {
      setModelsLoading(false);
    }
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<true | 'deferred' | null>(null);
  const [availablePackages, setAvailablePackages] = useState<string[]>([]);
  // Final compaction summary prompts (pi default + stored extension text),
  // shown in a modal on demand and refreshed after each save.
  interface SummaryPromptPreview { extra: string; guardTokens: number; fresh: string | null; update: string | null }
  const [summaryPrompt, setSummaryPrompt] = useState<SummaryPromptPreview | null>(null);
  const [showSummaryPromptModal, setShowSummaryPromptModal] = useState(false);
  const fetchSummaryPrompt = async () => {
    setSummaryPrompt(null);
    try {
      setSummaryPrompt(await apiJSON(API.settings.summaryPrompt));
    } catch {
      setSummaryPrompt({ extra: '', guardTokens: 0, fresh: null, update: null });
    }
  };
  const prevSseConnectedRef = useRef(sseConnected);
  // Settings as loaded / last saved — the baseline the floating Save button
  // compares against (shown only while something actually differs).
  const baselineRef = useRef('{}');
  // Deep link: the active section lives in the ?section= query param, so
  // browser back/forward restores the section that was open (same pattern
  // as EditsPage's ?e/?f/?r/?c params).
  const [params, setParams] = useSearchParams();
  const paramSection = params.get('section') || '';
  const selectSection = useCallback((id: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('section', id);
      return next;
    });
  }, [setParams]);

  // Reset saved state when SSE reconnects after backend restart
  useEffect(() => {
    if (saved && !prevSseConnectedRef.current && sseConnected) {
      setSaved(null);
    }
    prevSseConnectedRef.current = sseConnected;
  }, [sseConnected, saved]);

  useEffect(() => {
    Promise.all([
      apiJSON<any[]>(API.settings.schema),
      apiJSON<any>(API.settings.root),
      apiJSON<{ available?: string[] }>(API.extensions.packages).catch(() => null),
    ]).then(async ([schema, loaded, pkgs]) => {
      if (pkgs) setAvailablePackages(pkgs.available || []);
      if (schema) {
        // Sort once here, before render: menu + validation effect + default
        // selection all see the same alphabetical order
        setSchema([...schema]);
      }
      if (loaded) {
        setSettings(loaded);
        baselineRef.current = JSON.stringify(loaded);
      }
      fetchSummaryPrompt();
      setLoading(false);
    }).catch(() => {
      setError('Failed to load settings');
      setLoading(false);
    });
  }, []);

  // Keep the active menu item valid: unknown/missing ?section= falls back to
  // the first schema section (ids include the custom personas/apiTokens ones —
  // backend schema is the source of truth).
  const activeSection = !loading && !schema.some((s) => s.id === paramSection)
    ? (schema[0]?.id ?? '')
    : paramSection;
  // Auto-load the catalog once the Models section is opened; Update re-reads.
  useEffect(() => {
    if (activeSection === 'models' && catalog === null && !modelsLoading) loadCatalog();
  }, [activeSection, catalog, modelsLoading, loadCatalog]);

  const handleChange = useCallback((key: string, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setSaved(null);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await apiBody(API.settings.root, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(settings) });
      const savedSettings = { ...settings };
      if ('sessionTabLimit' in savedSettings) {
        savedSettings.sessionTabLimit = normalizeSessionTabLimit(savedSettings.sessionTabLimit);
        setSettings(savedSettings);
        onSessionTabLimitChange?.(savedSettings.sessionTabLimit);
      }
      baselineRef.current = JSON.stringify(savedSettings);
      setSaved(data.deferred ? 'deferred' : true);
      // Refresh the effective prompt after saving, but only show it on request.
      if ('summaryPromptExtra' in settings || 'summaryPromptGuardTokens' in settings) {
        await fetchSummaryPrompt();
      }
      // Banner is transient — the SSE-reconnect reset below only covers
      // backend restarts; a non-deferred save would otherwise stick forever.
      setTimeout(() => setSaved(null), data.deferred ? 8000 : 4000);
    } catch (err: any) {
      setError(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }, [settings, onSessionTabLimitChange]);

  // Shared shell for the plain label+description field variants

  const renderField = (field: SettingField) => {
    const value = settings[field.key] ?? '';

    if (field.type === 'toggle') {
      return (
        <div key={field.key} className="settings-field">
          <div className="settings-field-header">
            <label className="settings-label">{field.label}</label>
            <label className="settings-toggle">
              <input type="checkbox" checked={!!value} onChange={(e) => handleChange(field.key, e.target.checked)} />
              <span className="settings-toggle-slider" />
            </label>
          </div>
          {field.description && <div className="settings-description">{field.description}</div>}
        </div>
      );
    }

    if (field.type === 'select') {
      return (
        <div key={field.key} className="settings-field">
          <div className="settings-field-header">
            <label className="settings-label">{field.label}</label>
          </div>
          {field.description && <div className="settings-description">{field.description}</div>}
          <select
            className="settings-input"
            value={value as string}
            onChange={(e) => handleChange(field.key, e.target.value)}
          >
            <option value="">Auto (first available)</option>
            {(field.options || []).map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      );
    }

    if (field.type === 'packages') {
      const enabled: string[] = (Array.isArray(value) ? value : []).map((p: any) => (typeof p === 'string' ? p : p?.source || String(p)));
      const custom = enabled.filter((pkg) => !availablePackages.includes(pkg));
      const togglePkg = (pkg: string, on: boolean) => {
        handleChange(field.key, on ? [...enabled, pkg] : enabled.filter((p) => p !== pkg));
      };
      const pkgLabel = (pkg: string) => pkg.startsWith('local:') ? pkg.slice('local:'.length) : pkg;
      return (
        <FieldShell key={field.key} field={field}>
          <div className="settings-packages">
            {availablePackages.length === 0 && custom.length === 0 && (
              <div className="settings-description">No extensions installed in the master pi environment</div>
            )}
            {[...availablePackages].sort((a, b) => pkgLabel(a).localeCompare(pkgLabel(b))).map((pkg) => (
              <label key={pkg} className="settings-package-item">
                <input
                  type="checkbox"
                  checked={enabled.includes(pkg)}
                  onChange={(e) => togglePkg(pkg, e.target.checked)}
                />
                <span className="settings-package-name">{pkgLabel(pkg)}</span>
              </label>
            ))}
            {custom.map((pkg) => (
              <label key={pkg} className="settings-package-item">
                <input type="checkbox" checked onChange={() => togglePkg(pkg, false)} />
                <span className="settings-package-name">{pkg}</span>
              </label>
            ))}
          </div>
        </FieldShell>
      );
    }

    if (field.type === 'list') {
      return (
        <FieldShell key={field.key} field={field}>
          <SortableList
            items={Array.isArray(value) ? value : []}
            onChange={(items) => handleChange(field.key, items)}
            placeholder={field.listPlaceholder}
            addLabel={field.listAddLabel}
          />
        </FieldShell>
      );
    }

    if (field.type === 'folderIgnores') {
      const items: FolderIgnoreEntry[] = Array.isArray(value) ? value : [];
      // An entry with neither flag is useless — auto-drop the row
      const setItem = (i: number, patch: Partial<FolderIgnoreEntry>) =>
        handleChange(field.key, items
          .map((it, j) => (j === i ? { ...it, ...patch } : it))
          .filter((it) => it.edits || it.files));
      return (
        <FieldShell key={field.key} field={field}>
          <div className="sortable-list">
            {items.map((it, i) => (
              <div key={i} className="sortable-list-item">
                <input
                  className="sortable-list-input"
                  type="text"
                  value={it.path}
                  spellCheck={false}
                  onChange={(e) => setItem(i, { path: e.target.value })}
                />
                <label className="settings-ig-toggle" title="Hide from edit cards and the Changes list">
                  <input type="checkbox" checked={!!it.edits} onChange={(e) => setItem(i, { edits: e.target.checked })} /> edits
                </label>
                <label className="settings-ig-toggle" title="Hide from the Files file browser">
                  <input type="checkbox" checked={!!it.files} onChange={(e) => setItem(i, { files: e.target.checked })} /> files
                </label>
                <button className="sortable-list-remove" onClick={() => handleChange(field.key, items.filter((_, j) => j !== i))} title="Remove">✕</button>
              </div>
            ))}
            <FolderIgnoreAdd
              items={items}
              onAdd={(p) => handleChange(field.key, [...items, { path: p, edits: true, files: true }])}
            />
          </div>
        </FieldShell>
      );
    }

    if (field.type === 'mcpServers') {
      return <McpServersSection key={field.key} field={field} value={value} onChange={handleChange} />;
    }

    if (field.type === 'textarea') {
      return (
        <FieldShell key={field.key} field={field}>
          <textarea
            className="settings-input"
            rows={5}
            value={value}
            placeholder={field.placeholder || ''}
            spellCheck={false}
            onChange={(e) => handleChange(field.key, e.target.value)}
          />
          {field.key === 'summaryPromptExtra' && (
            <div className="settings-summary-prompt">
              <button
                type="button"
                className="btn btn-default settings-summary-toggle"
                onClick={() => setShowSummaryPromptModal(true)}
              >
                Show final prompt
              </button>
              {showSummaryPromptModal && (
                <Modal open onClose={() => setShowSummaryPromptModal(false)} className="modal-compaction-prompt">
                  <div className="modal-header">
                    <h3>Final compaction prompts</h3>
                    <button className="modal-close" onClick={() => setShowSummaryPromptModal(false)}>✕</button>
                  </div>
                  <div className="modal-body">
                    {!summaryPrompt ? (
                      <div className="settings-description">Loading final prompt…</div>
                    ) : summaryPrompt.fresh === null ? (
                    <div className="settings-description">Final prompt preview is unavailable on this server.</div>
                  ) : (
                    <>
                      <div className="settings-description">Effective prompt: pi's default plus your custom instructions (if any):</div>
                      {[["Fresh compaction", summaryPrompt.fresh], ['Update of a previous summary', summaryPrompt.update]].map(([label, text]) => (
                        <div key={label as string} className="settings-summary-block">
                          <div className="settings-summary-label">{label}</div>
                          <pre className="settings-summary-text">{text}</pre>
                        </div>
                      ))}
                    </>
                    )}
                  </div>
                </Modal>
              )}
            </div>
          )}
        </FieldShell>
      );
    }

    return (
      <FieldShell key={field.key} field={field}>
        <input
          type={field.type}
          className="settings-input"
          value={value}
          min={field.min}
          max={field.max}
          step={field.min !== undefined || field.max !== undefined ? 1 : undefined}
          placeholder={field.placeholder || ''}
          onBlur={(e) => {
            if (field.min === undefined && field.max === undefined) return;
            const number = Number(e.target.value);
            const normalized = Number.isFinite(number)
              ? Math.floor(Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, number)))
              : field.min ?? field.max ?? 0;
            handleChange(field.key, normalized);
          }}
          // new-password: the standard token telling browsers (incl. iOS
          // Passwords) this is NOT a login/signup field — suppresses the
          // save-password prompt (plain "off" is ignored for passwords).
          autoComplete={field.type === 'password' ? 'new-password' : undefined}
          onChange={(e) => handleChange(field.key, e.target.value)}
        />
      </FieldShell>
    );
  };

  const dirty = JSON.stringify(settings) !== baselineRef.current;

  // Side menu: the backend schema drives the full order — nothing appended
  // or sorted client-side.
  const menuItems = schema.map((s) => ({ id: s.id, label: s.label }));

  return (
    <div className="card settings-card">
      <div className="card-header">
        <span className="card-title">Settings</span>
      </div>

      {error && <div className="settings-error">{error}</div>}
      {saved && (
        <div className="settings-saved">
          {saved === 'deferred'
            ? 'Settings saved — the pi process restarts when the current turn ends.'
            : 'Settings saved. Restarting…'}
        </div>
      )}

      {loading ? (
        <div className="settings-loading">Loading settings…</div>
      ) : menuItems.length === 1 ? (
        <div className="settings-empty">No settings available for your enabled extensions.</div>
      ) : (
        <div className="settings-layout">
          <div className="settings-side">
            {/* Mobile: the category list collapses to a native dropdown
                (see styles.scss — .settings-menu-btn is hidden <=768px) */}
            <select
              className="settings-menu-select"
              value={activeSection}
              onChange={(e) => selectSection(e.target.value)}
              aria-label="Settings category"
            >
              {menuItems.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>

            <nav className="settings-menu" aria-label="Settings categories">
              {menuItems.map((item) => (
                <button
                  key={item.id}
                  className={`settings-menu-btn${activeSection === item.id ? ' active' : ''}`}
                  onClick={() => selectSection(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </nav>

            {/* Save action sits inside the side menu: always in the same
                place regardless of how far the form is scrolled */}
            {dirty && (
              <button className="btn btn-primary settings-save-btn" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save Settings'}
              </button>
            )}
          </div>

          <div className="settings-content">
            {activeSection === 'personas' ? (
              <PersonasSettingsSection />
            ) : activeSection === 'apiTokens' ? (
              <ApiTokensSection />
            ) : activeSection === 'notifications' ? (
              <NotificationsSection
                section={schema.find((s) => s.id === 'notifications')}
                settings={settings}
                handleChange={handleChange}
              />
            ) : activeSection === 'models' ? (
              <ModelsSection
                section={schema.find((s) => s.id === 'models')}
                settings={settings}
                catalog={catalog}
                modelsLoading={modelsLoading}
                modelsError={modelsError}
                loadCatalog={loadCatalog}
                handleChange={handleChange}
              />
            ) : (
              schema
                .filter((section) => section.id === activeSection)
                .map((section) => {
                  // Single-field MCP editor owns its own header row (title +
                  // Add button); anything else renders fields under the title.
                  if (section.fields.length === 1 && section.fields[0].type === 'mcpServers') {
                    const f = section.fields[0];
                    return (
                      <McpServersSection key={section.id} field={f} value={settings[f.key]} onChange={handleChange} />
                    );
                  }
                  return (
                    <div key={section.id} className="settings-section">
                      <div className="settings-section-head"><h3 className="settings-section-title">{section.label}</h3></div>
                      <div className="settings-section-fields">
                        {section.fields.map(renderField)}
                      </div>
                    </div>
                  );
                })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
