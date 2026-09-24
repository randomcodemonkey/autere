import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SortableList } from './SortableList';
import { PersonasSettingsSection } from './Personas';
import { url } from '../base-path';
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

export const SettingsCard: React.FC<SettingsCardProps> = ({ sseConnected }) => {
  const [schema, setSchema] = useState<SettingSection[]>([]);
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<true | 'deferred' | null>(null);
  const [availablePackages, setAvailablePackages] = useState<string[]>([]);
  const prevSseConnectedRef = useRef(sseConnected);
  // Settings as loaded / last saved — the baseline the floating Save button
  // compares against (shown only while something actually differs).
  const baselineRef = useRef('{}');
  const [activeSection, setActiveSection] = useState<string>('');

  // Reset saved state when SSE reconnects after backend restart
  useEffect(() => {
    if (saved && !prevSseConnectedRef.current && sseConnected) {
      setSaved(null);
    }
    prevSseConnectedRef.current = sseConnected;
  }, [sseConnected, saved]);

  useEffect(() => {
    Promise.all([
      fetch(url('/api/settings/schema')).then(r => r.json()),
      fetch(url('/api/settings')).then(r => r.json()),
      fetch(url('/api/extensions/packages')).then(r => r.json()).catch(() => null),
    ]).then(([schemaRes, settingsRes, pkgsRes]) => {
      if (pkgsRes?.success) setAvailablePackages(pkgsRes.data.available || []);
      if (schemaRes.success) {
        // Sort once here, before render: menu + validation effect + default
        // selection all see the same alphabetical order
        setSchema([...schemaRes.data].sort((a, b) => a.label.localeCompare(b.label)));
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

  // Keep the active menu item valid once the schema has loaded (empty
  // schema still allows the always-present Personas item).
  useEffect(() => {
    const ids = [...schema.map((s) => s.id), '__personas'];
    if (!loading && !ids.includes(activeSection)) setActiveSection(ids[0]);
  }, [schema, activeSection, loading]);

  const handleChange = useCallback((key: string, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setSaved(null);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(url('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (data.success) {
        baselineRef.current = JSON.stringify(settings);
        setSaved(data.deferred ? 'deferred' : true);
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
      const enabled: string[] = Array.isArray(value) ? value : [];
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

    if (field.type === 'perModel') {
      const map: Record<string, string | number> = value && typeof value === 'object' ? value : {};
      const models: string[] = Array.isArray(settings.enabledModels) ? settings.enabledModels : [];
      // '' clears the entry → the row falls back to the field's default
      const setEntry = (model: string, v: string) => {
        const next = { ...map };
        if (v === '') delete next[model];
        else next[model] = v;
        handleChange(field.key, next);
      };
      return (
        <FieldShell key={field.key} field={field}>
          {models.length === 0 ? (
            <div className="settings-description">Add enabled models first.</div>
          ) : (
            <div className="settings-per-model">
              {models.map((m) => (
                <div key={m} className="settings-per-model-row">
                  <span className="settings-per-model-name">{m}</span>
                  {field.perModel?.control === 'select' ? (
                    <select
                      className="settings-input"
                      value={String(map[m] ?? '')}
                      onChange={(e) => setEntry(m, e.target.value)}
                    >
                      {(field.perModel?.options || []).map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="number"
                      className="settings-input"
                      min={field.perModel?.min}
                      max={field.perModel?.max}
                      placeholder="default"
                      value={String(map[m] ?? '')}
                      onChange={(e) => setEntry(m, e.target.value)}
                    />
                  )}
                </div>
              ))}
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

  // Side-menu items: schema sections + the Personas section, alphabetically
  const menuItems = [
    ...schema.map((s) => ({ id: s.id, label: s.label })),
    { id: '__personas', label: 'Personas' },
  ].sort((a, b) => a.label.localeCompare(b.label));

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
              onChange={(e) => setActiveSection(e.target.value)}
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
                  onClick={() => setActiveSection(item.id)}
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
            {activeSection === '__personas' ? (
              <PersonasSettingsSection />
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
