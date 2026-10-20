import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SortableList } from './SortableList';
import { PersonasSettingsSection } from './Personas';
import { ApiTokensSection } from './ApiTokensSection';
import { NotificationsSection } from './NotificationsSection';
import { Modal } from './Modal';
import { url } from '../base-path';
import { API } from '../api-paths';
import type { SettingSection, SettingField } from '../types';

interface FolderIgnoreEntry { path: string; edits: boolean; files: boolean }

interface SettingsCardProps {
  sseConnected: boolean;
}

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

// Per-user pi mcp.json editor. One row per server: name, stdio command
// (+args) or http url, exposure, enabled. Rendered as a full section so the
// Add button can sit on the section title row.
let mcpRowSeq = 0;
const McpServersSection: React.FC<{ field: SettingField; value: unknown; onChange: (key: string, v: Record<string, any>) => void }> = ({ field, value, onChange }) => {
  const servers: Record<string, any> = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
  const names = Object.keys(servers);
  // Rows are keyed by a stable id, NOT the server name: the name field is
  // itself editable, so keying by name remounts the row on every keystroke
  // (focus loss). The map is rename-aware (name edit moves the id) and
  // pruned to current entries so removed/reloaded servers don't leak ids.
  const idsRef = useRef<Record<string, string>>({});
  const [headersDrafts, setHeadersDrafts] = useState<Record<string, string>>({});
  const rowId = (name: string): string => {
    if (!idsRef.current[name]) idsRef.current[name] = `mcp-row-${++mcpRowSeq}`;
    return idsRef.current[name];
  };
  const patch = (oldName: string, name: string, s: any) => {
    const next: Record<string, any> = {};
    for (const n of names) next[n === oldName ? name : n] = servers[n];
    next[name] = { ...next[name], ...s };
    // Rename: move the row id so the edited row keeps its DOM (and focus)
    if (oldName !== name && idsRef.current[oldName]) {
      idsRef.current[name] = idsRef.current[oldName];
      delete idsRef.current[oldName];
    }
    onChange(field.key, next);
  };
  // args round-trip through a comma-separated string; entries with
  // spaces/commas need the JSON-escape hatch (edit args via CLI/API).
  const argsText = (s: any) => Array.isArray(s.args) ? s.args.join(', ') : '';
  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-section-title">{field.label}</h3>
        <button
          className="btn btn-primary btn-row mcp-add-btn"
          type="button"
          onClick={() => onChange(field.key, { ...servers, [`server-${names.length + 1}`]: { command: '', args: [] } })}
        >
          Add MCP Server
        </button>
      </div>
      {field.description && <div className="settings-description">{field.description}</div>}
      <div className="sortable-list mcp-list">
        {names.map((name) => {
          const s = servers[name] || {};
          const id = rowId(name);
          const headersText = headersDrafts[id] ?? Object.entries(s.headers || {}).map(([h, v]) => `${h}: ${v}`).join('\n');
          const exposure = s.exposure || 'codemode';
          return (
            <div key={id} className="mcp-server-row">
              <div className="mcp-row-line">
                <div className="mcp-field">
                  <span className="mcp-field-label">Name</span>
                  <input
                    className="sortable-list-input mcp-name"
                    type="text"
                    value={name}
                    title="Server name (letters, digits, _ -)"
                    spellCheck={false}
                    onChange={(e) => patch(name, e.target.value.replace(/[^\w-]/g, '_'), s)}
                    placeholder="name"
                  />
                </div>
                <div className="mcp-field">
                  <span className="mcp-field-label">Type</span>
                  <select
                    className="settings-input mcp-kind"
                    value={s.command !== undefined ? 'stdio' : 'http'}
                    onChange={(e) => patch(name, name, e.target.value === 'stdio' ? { command: '', url: undefined } : { url: '', command: undefined })}
                  >
                    <option value="stdio">stdio</option>
                    <option value="http">http</option>
                  </select>
                </div>
                {s.command !== undefined ? (
                  <>
                    <div className="mcp-field">
                      <span className="mcp-field-label">Command</span>
                      <input
                        className="sortable-list-input mcp-command"
                        type="text"
                        value={s.command || ''}
                        placeholder="npx -y @modelcontextprotocol/server-everything"
                        spellCheck={false}
                        onChange={(e) => patch(name, name, { command: e.target.value })}
                      />
                    </div>
                    <div className="mcp-field">
                      <span className="mcp-field-label">Args</span>
                      <input
                        className="sortable-list-input mcp-args"
                        type="text"
                        value={argsText(s)}
                        placeholder="args, comma separated"
                        spellCheck={false}
                        onChange={(e) => patch(name, name, { args: e.target.value.split(',').map((a: string) => a.trim()).filter(Boolean) })}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mcp-field">
                      <span className="mcp-field-label">URL</span>
                      <input
                        className="sortable-list-input mcp-command"
                        type="text"
                        value={s.url || ''}
                        placeholder="https://example.com/mcp"
                        spellCheck={false}
                        onChange={(e) => patch(name, name, { url: e.target.value })}
                      />
                    </div>
                    <div className="mcp-field">
                      <span className="mcp-field-label">HTTP headers</span>
                      <div className="settings-description">One per line: Name: value</div>
                      <textarea
                        className="mcp-textarea"
                        rows={Math.max(2, Object.keys(s.headers || {}).length + 1)}
                        value={headersText}
                        placeholder={"Authorization: Bearer …\nX-Custom: value"}
                        spellCheck={false}
                        onChange={(e) => {
                          const text = e.target.value;
                          setHeadersDrafts((prev) => ({ ...prev, [id]: text }));
                          const headers: Record<string, string> | undefined = text.trim()
                            ? Object.fromEntries(
                              text.split('\n')
                                .map((l) => l.trim())
                                .filter(Boolean)
                                .map((l) => {
                                  const i = l.indexOf(':');
                                  return i < 0 ? null : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
                                })
                                .filter((h): h is [string, string] => h !== null && h[0] !== '')
                            )
                            : undefined;
                          patch(name, name, { headers });
                        }}
                        onBlur={() => setHeadersDrafts((prev) => {
                          if (!(id in prev)) return prev;
                          const next = { ...prev };
                          delete next[id];
                          return next;
                        })}
                      />
                    </div>
                  </>
                )}
                <div className="mcp-field mcp-field-wide">
                  <span className="mcp-field-label">Exposure</span>
                  <select
                    className="settings-input mcp-exposure"
                    value={s.exposure || 'codemode'}
                    title="How the server's tools reach the model"
                    onChange={(e) => patch(name, name, { exposure: e.target.value })}
                  >
                    <option value="codemode">codemode</option>
                    <option value="deferred">deferred (tool search)</option>
                    <option value="direct">direct</option>
                  </select>
                  <span className="settings-description" key={exposure}>
                    {exposure === 'codemode' && 'Tools stay out of the model’s tool declarations; codemode scripts call them via functions like mcp__server__tool and discover them with searchTools(). Keeps the context small and avoids tool-description injection.'}
                    {exposure === 'deferred' && 'The model first sees only a name stub per tool; calling one (or using tool_search) loads the full schema on demand. Callable both natively and from codemode.'}
                    {exposure === 'direct' && 'The full tool schemas are declared to the model like built-in tools. Most discoverable; costs the most context.'}
                  </span>
                </div>
              </div>
              <div className="mcp-field mcp-field-wide">
                <span className="mcp-field-label">Description</span>
                <textarea
                  className="mcp-textarea"
                  rows={2}
                  value={s.description || ''}
                  placeholder="What this server offers (shown in the system prompt and used by tool search)"
                  spellCheck={false}
                  onChange={(e) => patch(name, name, { description: e.target.value })}
                />
              </div>
              <div className="settings-field mcp-enabled-row">
                <div className="settings-field-header">
                  <label className="settings-label">Enabled</label>
                  <label className="settings-toggle" title="Connect this server when the session starts">
                    <input type="checkbox" checked={s.enabled !== false} onChange={(e) => patch(name, name, { enabled: e.target.checked })} />
                    <span className="settings-toggle-slider" />
                  </label>
                </div>
                <span className="settings-description">Enable or disable this server. When off, pi keeps the entry but does not connect to it.</span>
              </div>
              <div className="mcp-remove-row">
                <button className="btn btn-danger mcp-remove" onClick={() => onChange(field.key, Object.fromEntries(names.filter((n) => n !== name).map((n) => [n, servers[n]])))} title={`Remove ${name}`}>Remove</button>
              </div>
            </div>
          );
        })}
      </div>
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

export const SettingsCard: React.FC<SettingsCardProps> = ({ sseConnected }) => {
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
      const res = await fetch(url(API.modelsCatalog), { method: 'POST' });
      const json = await res.json();
      if (json.success) setCatalog(json.data as { provider: string; id: string; name: string }[]);
      else setModelsError(json.error || 'Failed to load models from pi');
    } catch {
      setModelsError('Failed to load models from pi');
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
      const res = await fetch(url(API.settings.summaryPrompt));
      const json = await res.json();
      if (json.success) setSummaryPrompt(json.data);
      else setSummaryPrompt({ extra: '', guardTokens: 0, fresh: null, update: null });
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
      fetch(url(API.settings.schema)).then(r => r.json()),
      fetch(url(API.settings.root)).then(r => r.json()),
      fetch(url(API.extensions.packages)).then(r => r.json()).catch(() => null),
    ]).then(async ([schemaRes, settingsRes, pkgsRes]) => {
      if (pkgsRes?.success) setAvailablePackages(pkgsRes.data.available || []);
      if (schemaRes.success) {
        // Sort once here, before render: menu + validation effect + default
        // selection all see the same alphabetical order
        setSchema([...schemaRes.data]);
      }
      if (settingsRes.success) {
        setSettings(settingsRes.data);
        baselineRef.current = JSON.stringify(settingsRes.data);
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
      const res = await fetch(url(API.settings.root), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (data.success) {
        baselineRef.current = JSON.stringify(settings);
        setSaved(data.deferred ? 'deferred' : true);
        // Refresh the effective prompt after saving, but only show it on request.
        if ('summaryPromptExtra' in settings || 'summaryPromptGuardTokens' in settings) {
          await fetchSummaryPrompt();
        }
        // Banner is transient — the SSE-reconnect reset below only covers
        // backend restarts; a non-deferred save would otherwise stick forever.
        setTimeout(() => setSaved(null), data.deferred ? 8000 : 4000);
      } else {
        setError(data.error || 'Failed to save settings');
      }
    } catch {
      setError('Failed to save settings');
    } finally {
      setSaving(false);
    }
  }, [settings]);

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
          placeholder={field.placeholder || ''}
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
