/**
 * OS-level notifications (Web Push).
 *
 * Browsers subscribe from Settings → Notifications; the subscription is
 * stored per user. Three kinds of events push a small JSON payload
 * ({ title, body, path, tag }) to every subscribed device — the service
 * worker (public/sw.js) turns it into a system notification and opens the
 * app at `path` (scope-relative) when it is tapped.
 *
 * VAPID keys are generated once and persisted under AUTERE_DIR.
 */

import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createTransport } from 'nodemailer';
import webpush from 'web-push';
import { AUTERE_DIR, USER_SETTINGS_DIR } from './constants.js';
import { getUserSetting } from './user-settings.js';
import { sanitizeUserName } from '../shared/format.js';
import { clipNotification } from '../shared/notifications.js';
import { log } from './logger.js';
import { writePrivateFile } from './private-file.js';

export type NotificationKind = 'explicit' | 'taskStart' | 'turnEnd' | 'allDone';

/** Settings toggle per notification kind (Settings → Notifications) */
const KIND_SETTINGS: Record<NotificationKind, string> = {
  explicit: 'notifyExplicit',
  taskStart: 'notifyTaskStart',
  turnEnd: 'notifyTurnEnd',
  allDone: 'notifyAllDone',
};

/** VAPID subject — a contact URL for push services. Apple rejects a
 *  `mailto:` with a non-domain host (`.localhost` → 403 BadJwtToken), so a
 *  reserved placeholder domain is used. */
const VAPID_SUBJECT = 'mailto:autere@randomcodemonkey.org';

export interface NotificationPayload {
  /** Subject: the session's name, or its id when the session has none */
  title: string;
  body: string;
  /** Scope-relative app path the notification opens (e.g. session/<id>) */
  path?: string | null;
}

type StoredSubscription = Pick<webpush.PushSubscription, 'endpoint' | 'keys'> & { expirationTime?: number | null };

type Vapid = { subject: string; publicKey: string; privateKey: string };

// ── VAPID keys ──

const VAPID_FILE = join(AUTERE_DIR, 'vapid-keys.json');
let vapidDetails: Vapid | null = null;

function loadVapid(): Vapid {
  if (vapidDetails) return vapidDetails;
  let keys: { publicKey: string; privateKey: string };
  if (existsSync(VAPID_FILE)) {
    keys = JSON.parse(readFileSync(VAPID_FILE, 'utf-8'));
  } else {
    keys = webpush.generateVAPIDKeys();
    mkdirSync(dirname(VAPID_FILE), { recursive: true });
    writePrivateFile(VAPID_FILE, JSON.stringify(keys, null, 2));
    log.notifications.info('Generated VAPID keys');
  }
  vapidDetails = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: VAPID_SUBJECT };
  return vapidDetails;
}

/** Public key the Notifications settings page subscribes with */
export function vapidPublicKey(): string {
  return loadVapid().publicKey;
}

// ── Subscriptions (per user) ──

function subsFile(user: string): string {
  return join(USER_SETTINGS_DIR, sanitizeUserName(user), 'push-subscriptions.json');
}

export function listSubscriptions(user: string): StoredSubscription[] {
  try {
    const raw = JSON.parse(readFileSync(subsFile(user), 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeSubscriptions(user: string, subs: StoredSubscription[]): void {
  const file = subsFile(user);
  writePrivateFile(file, JSON.stringify(subs, null, 2));
}

/** Shape check for a browser PushSubscription — an error message or null. */
export function validateSubscription(sub: unknown): string | null {
  const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!s || typeof s !== 'object') return 'subscription must be an object';
  if (typeof s.endpoint !== 'string' || !s.endpoint) return 'subscription.endpoint is required';
  if (typeof s.keys?.p256dh !== 'string' || !s.keys.p256dh) return 'subscription.keys.p256dh is required';
  if (typeof s.keys?.auth !== 'string' || !s.keys.auth) return 'subscription.keys.auth is required';
  return null;
}

/** Add or refresh a subscription (same endpoint = replace). */
export function saveSubscription(user: string, sub: StoredSubscription): number {
  const rest = listSubscriptions(user).filter((s) => s.endpoint !== sub.endpoint);
  rest.push({ endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expirationTime ?? null });
  writeSubscriptions(user, rest);
  return rest.length;
}

export function deleteSubscription(user: string, endpoint: string): boolean {
  const subs = listSubscriptions(user);
  const rest = subs.filter((s) => s.endpoint !== endpoint);
  if (rest.length === subs.length) return false;
  writeSubscriptions(user, rest);
  return true;
}

// ── Email (SMTP) channel ──
// Per-user settings (Settings → Notifications): notifySmtp toggle + server
// config. Same kind toggles, content limits and payload as push.

/** SMTP transport for a notification email; input already validated. */
function smtpTransport(cfg: { host: string; port: number; tls: string; user?: string; pass?: string }) {
  return createTransport({
    // EHLO as a hostname, not an address literal: exim reverse-DNSes
    // address-literal HELOs and eats the resolver timeout (~5s).
    name: 'autere',
    host: cfg.host,
    port: cfg.port,
    secure: cfg.tls === 'implicit', // TLS from the first byte (port 465)
    requireTLS: cfg.tls === 'starttls', // start plaintext, then STARTTLS
    ignoreTLS: cfg.tls === 'none',
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/**
 * Deliver one notification by email — fire-and-forget helper shared by
 * sendNotification; resolves with the same {sent, reason} shape.
 */
async function sendEmail(
  user: string,
  payload: NotificationPayload,
  cfg: { host: string; port: number; tls: string; user?: string; pass?: string; address: string },
): Promise<{ sent: number; reason?: string }> {
  const t0 = Date.now();
  try {
    const transport = smtpTransport(cfg);
    try {
      const accepted = await transport.sendMail({
        from: cfg.address,
        to: cfg.address,
        subject: clipNotification(payload.title),
        text: payload.body,
      });
      // Relay id in the log: an accepted-but-lost mail is traceable to the
      // upstream MTA's queue via this id.
      log.notifications.info(`Email notification to "${user}" delivered in ${Date.now() - t0}ms (relay: ${accepted.response})`);
      return { sent: 1 };
    } finally {
      transport.close();
    }
  } catch (err: any) {
    // err.response carries the SMTP server's own refusal text when there is one
    const reason = `${err?.message ?? err}${err?.response ? ` — ${err.response}` : ''}`;
    log.notifications.error(`Email notification to "${user}" failed after ${Date.now() - t0}ms: ${reason}`);
    return { sent: 0, reason };
  }
}

  // ── Sending ──

/** Whether the user wants this kind of notification (default on). */
export function notificationsWanted(user: string, kind: NotificationKind): boolean {
  return getUserSetting(user, KIND_SETTINGS[kind], true) !== false;
}

/**
 * The user's SMTP config when email notifications are enabled AND valid;
 * null otherwise (reason logged by the caller when a config is broken).
 * Password is stored in the user's settings file in plain text — same file
 * already holds pi API keys.
 */
export function getSmtpConfig(user: string): {
  host: string; port: number; tls: string; user?: string; pass?: string; address: string;
} | null {
  if (getUserSetting(user, 'notifySmtp', false) !== true) return null;
  const host = String(getUserSetting(user, 'notifySmtpHost', '')).trim();
  if (!host) return null;
  const portRaw = getUserSetting(user, 'notifySmtpPort', 587);
  const port = typeof portRaw === 'number' ? portRaw : parseInt(String(portRaw), 10);
  const tls = String(getUserSetting(user, 'notifySmtpTls', 'starttls'));
  if (!Number.isFinite(port) || port < 1 || port > 65535 || !["implicit", "starttls", "none"].includes(tls)) return null;
  const address = String(getUserSetting(user, 'notifyEmailAddress', '')).trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(address)) return null;
  const user0 = String(getUserSetting(user, 'notifySmtpUser', '')).trim();
  const pass0 = String(getUserSetting(user, 'notifySmtpPass', ''));
  return { host, port, tls, user: user0 || undefined, pass: pass0 || undefined, address };
}

/**
 * Push one notification to every subscribed device of `user` (kind toggles
 * apply to both channels) and, when the user enabled it, send the same
 * notification by email. Dead subscriptions (404/410 from the push service)
 * are dropped. Resolves with the delivery count across channels; never
 * rejects — a failed notification must not take down the turn end / task
 * run that triggered it.
 */
export async function sendNotification(
  user: string,
  kind: NotificationKind,
  payload: NotificationPayload,
): Promise<{ sent: number; reason?: string }> {
  try {
    if (!notificationsWanted(user, kind)) return { sent: 0, reason: `${kind} notifications are off in Settings → Notifications` };
    const reasons: string[] = [];

    // Channel 1: web push to every subscribed device.
    let sent = 0;
    const subs = listSubscriptions(user);
    if (subs.length === 0) {
      reasons.push('no subscribed device — enable notifications in Settings → Notifications');
    }
    const body = JSON.stringify({
      title: payload.title,
      body: clipNotification(payload.body),
      path: payload.path || null,
      tag: kind,
    });
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, body, { vapidDetails: loadVapid(), TTL: 24 * 3600 });
        sent++;
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          deleteSubscription(user, sub.endpoint);
          log.notifications.info(`Dropped expired push subscription of "${user}" (${err.statusCode})`);
        } else {
          // StatusCode + body: the push service's reason (Apple answers
          // 403 BadJwtToken / BadAuthorizationHeader with a JSON body).
          log.notifications.error(
            `Push to "${user}" failed: ${err?.statusCode ?? '?'} ${err?.body ?? ''} ${err?.message ?? err}`);
        }
      }
    }

    // Channel 2: email, when the user enabled SMTP and configured it.
    const smtp = getSmtpConfig(user);
    if (smtp) {
      const email = await sendEmail(user, payload, smtp);
      sent += email.sent;
      if (email.sent === 0 && email.reason) reasons.push(`email: ${email.reason}`);
    }

    if (sent > 0) return { sent };
    return { sent: 0, reason: reasons.length > 0 ? reasons.join('; ') : 'delivery failed on every channel' };
  } catch (err) {
    log.notifications.error(`sendNotification(${kind}) for "${user}" failed:`, err);
    return { sent: 0, reason: 'notification delivery failed' };
  }
}
