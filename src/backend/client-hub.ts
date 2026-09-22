/**
 * Per-user client hub.
 *
 * Two maps per user:
 * - bindings: clientId → the pi session file the client is VIEWING. Durable —
 *   survives SSE reconnects and page reloads (same tab keeps its
 *   autere-client-id via sessionStorage). Only bootstrap/switch/new-session
 *   change it. This ordering matters: a page's bootstrap fetch can land
 *   BEFORE its SSE connection registers, and the binding must survive that.
 * - streams: the live SSE transports, keyed by the same client id. Ephemeral.
 *
 * Events route to the clients whose BINDING matches the session, across all
 * the user's pi processes. This is what lets several pi processes stream in
 * parallel while each dashboard client sees exactly its session. Replaces the
 * old per-process peer registry ("active elsewhere") — with one process per
 * session there is no cross-process forwarding at all.
 */

import type { ServerResponse } from 'http';
import { log } from './logger.js';

const bindingsByUser = new Map<string, Map<string, string | null>>();
const streamsByUser = new Map<string, Map<string, ServerResponse>>();

function userBindings(user: string): Map<string, string | null> {
  let m = bindingsByUser.get(user);
  if (!m) {
    m = new Map();
    bindingsByUser.set(user, m);
  }
  return m;
}

function userStreams(user: string): Map<string, ServerResponse> {
  let m = streamsByUser.get(user);
  if (!m) {
    m = new Map();
    streamsByUser.set(user, m);
  }
  return m;
}

/** Register an SSE transport for a client (fires on res close → drop transport only). */
export function registerClient(user: string, clientId: string, res: ServerResponse): void {
  const streams = userStreams(user);
  const prev = streams.get(clientId);
  if (prev && prev !== res) {
    // Reconnect with the same client id (reload/reconnect): the new stream
    // takes over; the binding is untouched (it lives in bindingsByUser).
    try { prev.end(); } catch {}
  }
  streams.set(clientId, res);
  // ponytail: stale clientIds (closed tabs) linger in bindings forever; fine
  // for dashboard scale — clean up here if it ever matters.
  res.on('close', () => {
    if (streams.get(clientId) === res) streams.delete(clientId);
  });
}

/** Which session file this client is viewing (null = unknown yet) */
export function getClientSession(user: string, clientId: string | null): string | null {
  if (!clientId) return null;
  return userBindings(user).get(clientId) ?? null;
}

/** Bind a client to a session file (null = detach) */
export function setClientSession(user: string, clientId: string | null, sessionFile: string | null): void {
  if (!clientId) return;
  userBindings(user).set(clientId, sessionFile);
}

/** Write an SSE event to all of the user's clients viewing sessionFile */
export function deliverToSession(user: string, sessionFile: string | null, data: any): void {
  if (!sessionFile) return;
  const streams = streamsByUser.get(user);
  const bindings = userBindings(user);
  if (!streams) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const [clientId, res] of streams) {
    if (bindings.get(clientId) !== sessionFile) continue;
    try {
      res.write(msg);
    } catch (err) {
      log.userSession.warn(`SSE write failed, dropping client ${clientId.slice(0, 12)}: ${err}`);
      try { res.end(); } catch {}
      streams.delete(clientId);
    }
  }
}

/** Write an SSE event to ALL of the user's clients (session lists, extensions) */
export function broadcastToUser(user: string, data: any): void {
  const streams = streamsByUser.get(user);
  if (!streams) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const [clientId, res] of streams) {
    try {
      res.write(msg);
    } catch (err) {
      log.userSession.warn(`SSE write failed, dropping client ${clientId.slice(0, 8)}: ${err}`);
      try { res.end(); } catch {}
      streams.delete(clientId);
    }
  }
}

/** All session files currently viewed by the user's clients */
export function viewedSessions(user: string): Set<string | null> {
  const out = new Set<string | null>();
  for (const f of userBindings(user).values()) out.add(f);
  return out;
}

/** Users that currently have at least one connected client */
export function hubUsers(): string[] {
  return [...streamsByUser.keys()].filter((u) => (streamsByUser.get(u)?.size || 0) > 0);
}