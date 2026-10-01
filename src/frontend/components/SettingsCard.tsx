import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SortableList } from './SortableList';
import { PersonasSettingsSection } from './Personas';
import { ApiTokensSection } from './ApiTokensSection';
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
      <h3 className="settings-section-title">{section.label}</h3>
      <div className="settings-section-fields">
        {catalog === null && (
          <div className="settings-description">{modelsLoading ? 'Loading models from pi…' : 'Update loads the model catalog from pi.'}</div>
        )}
        <div className="settings-field">
          <div className="settings-description">
            Per-model values apply to ENABLED models; saving restarts the agent.
          </div>
          {modelsError && <div className="settings-description">{modelsError}</div>}
        <button className="btn btn-primary models-update-btn" type="button" disabled={modelsLoading} onClick={loadCatalog}>
          {modelsLoading ? 'Updating models…' : 'Update available models'}
        </button>
          {catalog !== null && (
            rows.length === 0 ? (
              <div className="settings-description">No models reported by pi.</div>
            ) : (
              <table className="models-table">
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
    ]).then(([schemaRes, settingsRes, pkgsRes]) => {
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
      return (
        <FieldShell key={field.key} field={field}>
          <div className="settings-packages">
            {availablePackages.length === 0 && custom.length === 0 && (
              <div className="settings-description">No extensions installed in the master pi environment</div>
            )}
            {availablePackages.map((pkg) => (
              <label key={pkg} className="settings-package-item">
                <input
                  type="checkbox"
                  checked={enabled.includes(pkg)}
                  onChange={(e) => togglePkg(pkg, e.target.checked)}
                />
                <span className="settings-package-name">{pkg}</span>
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
                .map((section) => (
                  <div key={section.id} className="settings-section">
                    <h3 className="settings-section-title">{section.label}</h3>
                    <div className="settings-section-fields">
                      {section.fields.map(renderField)}
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
