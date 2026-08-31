import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '../components/Header';
import { SortableList } from '../components/SortableList';
import { url } from '../base-path';
import type { SettingSection, SettingField } from '../types';

interface SettingsPageProps {
  authenticated: boolean;
  username: string | null;
  statusType: string;
  statusText: string;
  onStatusClick: () => void;
  sseConnected: boolean;
}

export function SettingsPage({
  authenticated,
  username,
  statusType,
  statusText,
  onStatusClick,
  sseConnected,
}: SettingsPageProps) {
  const [schema, setSchema] = useState<SettingSection[]>([]);
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const navigate = useNavigate();
  const prevSseConnectedRef = useRef(sseConnected);

  // Reset saved state when SSE reconnects after backend restart
  useEffect(() => {
    if (saved && !prevSseConnectedRef.current && sseConnected) {
      setSaved(false);
    }
    prevSseConnectedRef.current = sseConnected;
  }, [sseConnected, saved]);

  useEffect(() => {
    Promise.all([
      fetch(url('/api/settings/schema')).then(r => r.json()),
      fetch(url('/api/settings')).then(r => r.json()),
    ]).then(([schemaRes, settingsRes]) => {
      if (schemaRes.success) setSchema(schemaRes.data);
      if (settingsRes.success) setSettings(settingsRes.data);
      setLoading(false);
    }).catch(() => {
      setError('Failed to load settings');
      setLoading(false);
    });
  }, []);

  const handleChange = useCallback((key: string, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setSaved(false);
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
        setSaved(true);
      } else {
        setError(data.error || 'Failed to save settings');
      }
    } catch {
      setError('Failed to save settings');
    } finally {
      setSaving(false);
    }
  }, [settings]);

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

    if (field.type === 'list') {
      return (
        <div key={field.key} className="settings-field">
          <label className="settings-label">{field.label}</label>
          {field.description && <div className="settings-description">{field.description}</div>}
          <SortableList
            items={Array.isArray(value) ? value : []}
            onChange={(items) => handleChange(field.key, items)}
            placeholder={field.listPlaceholder}
            addLabel={field.listAddLabel}
          />
        </div>
      );
    }

    return (
      <div key={field.key} className="settings-field">
        <label className="settings-label">{field.label}</label>
        {field.description && <div className="settings-description">{field.description}</div>}
        <input
          type={field.type}
          className="settings-input"
          value={value}
          placeholder={field.placeholder || ''}
          onChange={(e) => handleChange(field.key, e.target.value)}
        />
      </div>
    );
  };

  return (
    <div id="main-app" className={authenticated ? 'authenticated' : ''}>
      <Header
        statusType={statusType}
        statusText={statusText}
        onStatusClick={onStatusClick}
        sessionId={null}
        sessionName={null}
        onSessionClick={() => navigate('/', { replace: true })}
        externalActivity={false}
        isActive={false}
      />

      <div className="settings-page">
        <div className="card settings-card">
          <div className="card-header">
            <span className="card-title">Settings</span>
          </div>

          {error && <div className="settings-error">{error}</div>}
          {saved && <div className="settings-saved">Settings saved. Restarting…</div>}

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
              </div>

              <div className="settings-actions">
                <button className="btn btn-primary" onClick={handleSave} disabled={saving || saved}>
                  {saving ? 'Saving…' : saved ? 'Saved' : 'Save Settings'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
