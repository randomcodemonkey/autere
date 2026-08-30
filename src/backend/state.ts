import type { ExtensionInfo, SessionInfo } from './types.js';

// ── Shared state (global across all sessions) ──

export let extensionsState: ExtensionInfo[] = [];
export let availableSessions: SessionInfo[] = [];
