import React, { useState, useEffect, useCallback } from 'react';
import { url } from '../base-path';
import { API } from '../api-paths';
import type { SettingSection } from '../types';

interface NotificationsSectionProps {
  section?: SettingSection;
  settings: Record<string, any>;
  handleChange: (key: string, value: any) => void;
}

/** VAPID applicationServerKey: base64url-ish public key → Uint8Array */
function toApplicationServerKey(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Settings → Notifications: subscribes THIS browser to Web Push (the OS
 * shows the notifications; tapping one opens the app at the session it is
 * about) and holds the per-kind toggles the backend schema provides.
 */
export const NotificationsSection: React.FC<NotificationsSectionProps> = ({ section, settings, handleChange }) => {
  const [supported, setSupported] = useState(true);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isSecureContext || !('Notification' in window) || !('serviceWorker' in navigator)) {
      setSupported(false);
      return;
    }
    setPermission(Notification.permission);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      setSubscribed(!!(reg && (await reg.pushManager.getSubscription())));
    } catch {
      /* nothing subscribed yet */
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const enable = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const granted = await Notification.requestPermission();
      setPermission(granted);
      if (granted !== 'granted') {
        setError('Notification permission was not granted — allow notifications for this site, then try again.');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const key = await fetch(url(API.notifications.vapidPublicKey)).then((r) => r.json());
        if (!key.success) throw new Error(key.error || 'Failed to read the push key');
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: toApplicationServerKey(key.data.publicKey),
        });
      }
      const res = await fetch(url(API.notifications.subscribe), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed to register this device');
      setSubscribed(true);
      setNote('This device is now subscribed.');
    } catch (err) {
      setError(`Could not enable notifications: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await fetch(url(API.notifications.subscribe), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setSubscribed(false);
      setNote('This device is unsubscribed.');
    } catch (err) {
      setError(`Could not disable notifications: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const deviceBlock = !supported ? (
    <div className="settings-description">
      Web notifications are unavailable in this browser context —{' '}
      {!isSecureContext
        ? 'the page is not served over HTTPS (or localhost), which iOS and desktop browsers require before exposing notifications to a site.'
        : !('Notification' in window)
          ? 'this browser does not expose the Notification API. On iOS, notifications only work for the PWA added to the Home Screen (iOS 16.4+) — install this instance from Safari’s share menu and open it via its icon.'
          : 'this browser has no service-worker support.'}
    </div>
  ) : permission === 'denied' ? (
    <div className="settings-description">
      Notifications are blocked — allow them for this site in your browser settings, then reload.
    </div>
  ) : subscribed ? (
    <>
      <div className="settings-description">Subscribed — this device receives the notifications selected below.</div>
      <button className="btn" type="button" disabled={busy} onClick={disable}>
        {busy ? 'Working…' : 'Unsubscribe this device'}
      </button>
    </>
  ) : (
    <>
      <div className="settings-description">
        Not subscribed — subscribe this device to receive the notifications selected below (requires a service worker;
        iOS needs the app added to the home screen).
      </div>
      <button className="btn btn-primary" type="button" disabled={busy} onClick={enable}>
        {busy ? 'Subscribing…' : 'Subscribe this device'}
      </button>
    </>
  );

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-section-title">Notifications</h3>
      </div>
      <div className="settings-section-fields">
        <div className="settings-field">
          <div className="settings-field-header">
            <label className="settings-label">This device</label>
          </div>
          {deviceBlock}
          {error && <div className="settings-error">{error}</div>}
          {note && <div className="settings-saved">{note}</div>}
        </div>

        {(section?.fields || []).map((field) => (
          <div key={field.key} className="settings-field">
            <div className="settings-field-header">
              <label className="settings-label">{field.label}</label>
              {field.type === 'toggle' && (
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings[field.key] !== false}
                    onChange={(e) => handleChange(field.key, e.target.checked)}
                  />
                  <span className="settings-toggle-slider" />
                </label>
              )}
            </div>
            {field.description && <div className="settings-description">{field.description}</div>}
            {field.type === 'number' && (
              <input
                type="number"
                min={0}
                className="settings-input"
                value={String(settings[field.key] ?? '')}
                onChange={(e) => handleChange(field.key, e.target.value)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
