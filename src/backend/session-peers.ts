/**
 * Per-user session-activity hub.
 *
 * A user can have several UserSessions (one per device/token), each with
 * its own pi process, all able to view and drive the same session.
 * "Active elsewhere" means: another UserSession of the SAME user is
 * currently streaming (driving) the session I'm viewing.
 *
 * This registry replaces the old file-polling approach entirely:
 * activity is derived live from each peer's RPC-driven isStreaming state —
 * no filesystem checks, no polling intervals, no expiry timeouts.
 * Writes to the session file by processes we don't manage (e.g. someone
 * running pi manually) are deliberately invisible.
 */

import { log } from './logger.js';

export interface SessionPeer {
  /** Session id this peer's pi is currently driving while streaming, or null */
  getDrivenSessionId(): string | null;
  /**
   * Deliver an SSE event to this peer's clients viewing sessionId.
   * Must NOT forward the event onward (no recursion).
   */
  deliverToSession(sessionId: string | null, data: any): void;
}

const peersByUser = new Map<string, Set<SessionPeer>>();

/** Register a UserSession as an activity peer for its user. Returns unregister. */
export function registerSessionPeer(user: string, peer: SessionPeer): () => void {
  let set = peersByUser.get(user);
  if (!set) {
    set = new Set();
    peersByUser.set(user, set);
  }
  set.add(peer);
  return () => {
    const s = peersByUser.get(user);
    if (!s) return;
    s.delete(peer);
    if (s.size === 0) peersByUser.delete(user);
  };
}

/** Whether any OTHER UserSession of the user is currently streaming on sessionId. */
export function isSessionActiveElsewhere(user: string, except: SessionPeer, sessionId: string | null): boolean {
  if (!sessionId) return false;
  const set = peersByUser.get(user);
  if (!set) return false;
  for (const peer of set) {
    if (peer !== except && peer.getDrivenSessionId() === sessionId) return true;
  }
  return false;
}

/**
 * Deliver an SSE event to all peers of the user (except the sender).
 * Each peer writes it only to its own clients viewing sessionId.
 */
export function deliverToPeers(user: string, except: SessionPeer, sessionId: string | null, data: any): void {
  if (!sessionId) return;
  const set = peersByUser.get(user);
  if (!set) return;
  for (const peer of set) {
    if (peer === except) continue;
    try {
      peer.deliverToSession(sessionId, data);
    } catch (err) {
      log.userSession.error('Failed to deliver event to session peer:', err);
    }
  }
}
