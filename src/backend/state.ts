import { IncomingMessage, ServerResponse } from 'http';
import { StreamEntry, SessionInfo, ExtensionInfo, SessionStats, ToolEntry, MessagePreview } from './types.js';

// ── Core mutable state ──

export let sessionState: any = {
  model: null,
  thinkingLevel: 'off',
  isStreaming: false,
  messageCount: 0,
  requestCount: 0,
  pendingMessageCount: 0,
  sessionFile: null,
  sessionId: null,
  sessionName: null,
  connected: false,
  startTime: Date.now(),
  compacting: false
};

export let sessionStats: SessionStats = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0,
  contextUsage: null
};

// ── Stream history ──

export let streamHistory: StreamEntry[] = [];
export let currentStreamText = '';
export let currentStreamRole = '';
export let activeStreamIdx: number | null = null;

// ── Message / tool tracking ──

export let recentMessages: MessagePreview[] = [];
export let activeTools: Map<string, any> = new Map();
export let recentTools: ToolEntry[] = [];

// ── Models ──

export let availableModels: { provider: string; id: string; name?: string; thinkingLevel?: string }[] = [];

// ── Extensions ──

export let extensionsState: ExtensionInfo[] = [];

// ── Sessions ──

export let availableSessions: SessionInfo[] = [];

// ── SSE clients ──

export const sseClients: Set<ServerResponse> = new Set();

// ── Session creation flag ──

export let newSessionCreating = false;

// ── History loaded marker ──

export let historyLoadedSessionId: string | null = null;

// ── Setters for state ──

export function setNewSessionCreating(val: boolean) { newSessionCreating = val; }
export function setHistoryLoadedSessionId(id: string | null) { historyLoadedSessionId = id; }
export function setAvailableModels(models: { provider: string; id: string; name?: string; thinkingLevel?: string }[]) { availableModels = models; }

export function setActiveStreamIdx(i: number | null) { activeStreamIdx = i; }
export function setCurrentStreamText(t: string) { currentStreamText = t; }
export function setCurrentStreamRole(r: string) { currentStreamRole = r; }

export function resetSessionState() {
  sessionState.messageCount = 0;
  sessionState.requestCount = 0;
  sessionState.isStreaming = false;
  sessionStats.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  sessionStats.cost = 0;
  sessionStats.contextUsage = null;
  recentMessages.length = 0;
  activeTools.clear();
  recentTools.length = 0;
  streamHistory.length = 0;
  currentStreamText = '';
  currentStreamRole = '';
  activeStreamIdx = null;
  historyLoadedSessionId = null;
}
