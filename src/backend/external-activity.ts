import { log } from './logger.js';
/**
 * Cross-session external-activity registry.
 *
 * Each UserSession registers interest in the session file pi is currently
 * on (re-evaluated via a getter, since the session can change). When any
 * UserSession receives an RPC event from its pi process, it calls
 * notifyExternalActivity() so every OTHER UserSession watching the same
 * session file learns about the write instantly — instead of waiting up
 * to 3s for the file-size poll in checkExternalActivity().
 */

export interface ExternalActivityInterest {
  /** Returns the session file the subscriber is currently interested in (or null) */
  getSessionFile: () => string | null;
  /** Called when another pi process wrote to that session file */
  onExternalActivity: () => void;
  /** Called when another pi process's turn ended on that session file */
  onExternalActivityEnd?: () => void;
}

const interests = new Set<ExternalActivityInterest>();

export function registerExternalActivityInterest(interest: ExternalActivityInterest): () => void {
  interests.add(interest);
  return () => { interests.delete(interest); };
}

export function notifyExternalActivity(sessionFile: string | null, source: ExternalActivityInterest): void {
  if (!sessionFile) return;
  for (const interest of interests) {
    if (interest === source) continue;
    try {
      if (interest.getSessionFile() === sessionFile) {
        interest.onExternalActivity();
      }
    } catch (err) {
      log.extActivity.error('Error notifying external activity interest:', err);
    }
  }
}

/**
 * Notify every OTHER UserSession watching sessionFile that the driving
 * pi process's turn has ENDED. Lets them clear their 'Active elsewhere'
 * state immediately instead of waiting out the 60s inactivity expiry.
 */
export function notifyExternalActivityEnd(sessionFile: string | null, source: ExternalActivityInterest): void {
  if (!sessionFile) return;
  for (const interest of interests) {
    if (interest === source) continue;
    try {
      if (interest.getSessionFile() === sessionFile) {
        interest.onExternalActivityEnd?.();
      }
    } catch (err) {
      log.extActivity.error('Error notifying external activity end:', err);
    }
  }
}
