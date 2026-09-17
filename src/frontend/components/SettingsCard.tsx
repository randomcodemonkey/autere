import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SortableList } from './SortableList';
import { PersonasSettingsSection } from './Personas';
import { url } from '../base-path';
import type { SettingSection, SettingField } from '../types';

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
      if (schemaRes.success) setSchema(schemaRes.data);
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
      ) : schema.length === 0 ? (
        <div className="settings-empty">No settings available for your enabled extensions.</div>
      ) : (
        <>
          <div className="settings-sections">
            {schema.map((section) => (
              <div key={section.id} className="settings-section">
                <h3 className="settings-section-title">{section.label}</h3>
                <div className="settings-section-fields">
                  {section.fields.map(renderField)}
                </div>
              </div>
            ))}
            <PersonasSettingsSection />
          </div>

          {/* Floating save action: only while there are unsaved changes —
              fixed position keeps it visible no matter how far the page is
              scrolled (the in-flow button at the page end was easy to miss). */}
          {dirty && !loading && (
            <div className="settings-save-float">
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save Settings'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
