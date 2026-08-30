/**
 * Per-user session management.
 *
 * Each UserSession encapsulates a pi RPC process, its state,
 * event handlers, and SSE clients for a single authenticated user.
 */

import { randomUUID } from 'crypto';
import type { ServerResponse } from 'http';
import { MonitorRpcClient } from './rpc-client.js';
import { filterScopedModels } from './utils.js';
import { getLastSession, setLastSession } from './auth.js';

// ── Per-user state types ──

export interface UserSessionState {
  sessionState: any;
  sessionStats: any;
  streamHistory: any[];
  recentMessages: any[];
  activeTools: Map<string, any>;
  recentTools: any[];
  availableModels: any[];
  availableSessions: any[];
  extensionsState: any[];
  newSessionCreating: boolean;
  historyLoadedSessionId: string | null;
  currentStreamText: string;
  currentStreamRole: string;
  activeStreamIdx: number | null;
}

function createInitialState(): UserSessionState {
  return {
    sessionState: {
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
      compacting: false,
    },
    sessionStats: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextUsage: null,
    },
    streamHistory: [],
    recentMessages: [],
    activeTools: new Map(),
    recentTools: [],
    availableModels: [],
    availableSessions: [],
    extensionsState: [],
    newSessionCreating: false,
    historyLoadedSessionId: null,
    currentStreamText: '',
    currentStreamRole: '',
    activeStreamIdx: null,
  };
}

// ── UserSession ──

export class UserSession {
  readonly user: string;
  readonly rpc: MonitorRpcClient;
  readonly state: UserSessionState;
  readonly sseClients: Set<ServerResponse> = new Set();
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity: number = Date.now();
  private _idleTimeoutMs: number;
  private _onIdle: (() => void) | null = null;

  constructor(user: string, rpcOptions: { provider?: string; model?: string; args?: string[] }, idleTimeoutMs: number = 30 * 60 * 1000) {
    this.user = user;
    // Resume user's last session if known
    const args = [...(rpcOptions.args || [])];
    const lastSession = getLastSession(user);
    if (lastSession && !args.includes('--session') && !args.includes('--continue') && !args.includes('-c')) {
      args.push('--session', lastSession);
    }
    this.rpc = new MonitorRpcClient({ ...rpcOptions, args });
    this.state = createInitialState();
    this._idleTimeoutMs = idleTimeoutMs;
  }

  /** Set callback for when session goes idle */
  onIdle(cb: () => void) {
    this._onIdle = cb;
  }

  /** Mark activity and reset idle timer */
  touch() {
    this.lastActivity = Date.now();
    this.resetIdleTimer();
  }

  private resetIdleTimer() {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = setTimeout(() => {
      console.log(`[autere] User "${this.user}" idle timeout, terminating pi process`);
      this._onIdle?.();
    }, this._idleTimeoutMs);
  }

  /** Broadcast an SSE event to all connected clients */
  broadcast(data: any) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try { client.write(msg); } catch {}
    }
  }

  /** Start the pi RPC process and register event handlers */
  async start(): Promise<void> {
    await this.rpc.start();
    this.state.sessionState.connected = true;
    this.state.sessionState.startTime = Date.now();

    // Register event handlers
    this.registerEventHandlers();

    // Fetch initial state
    await this.fetchInitialState();

    // Start idle timer
    this.resetIdleTimer();

    console.log(`[autere] User "${this.user}" pi process started`);
  }

  /** Stop the pi RPC process */
  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    try {
      await this.rpc.stop();
    } catch {}
    // Disconnect all SSE clients
    for (const client of this.sseClients) {
      try { client.end(); } catch {}
    }
    this.sseClients.clear();
    console.log(`[autere] User "${this.user}" pi process stopped`);
  }

  /** Whether the pi process is running */
  get isRunning(): boolean {
    return this.rpc.isRunning;
  }

  // ── Private ──

  private async fetchInitialState(): Promise<void> {
    try {
      const state = await this.rpc.getState();
      if (state.sessionId) this.state.sessionState.sessionId = state.sessionId;
      if (state.sessionFile) this.state.sessionState.sessionFile = state.sessionFile;
      this.state.sessionState.sessionName = state.sessionName || null;
      this.state.sessionState.isStreaming = state.isStreaming;
      this.state.sessionState.compacting = state.isCompacting;
      if (state.model) {
        this.state.sessionState.model = {
          provider: state.model.provider,
          id: state.model.id,
          name: state.model.name || state.model.id,
        };
      }

      try {
        const stats = await this.rpc.getSessionStats();
        this.state.sessionState.messageCount = stats.userMessages || 0;
        this.state.sessionState.requestCount = stats.userMessages || 0;
        this.state.sessionStats.tokens = stats.tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        this.state.sessionStats.cost = stats.cost || 0;
        if (stats.contextUsage) this.state.sessionStats.contextUsage = stats.contextUsage;
      } catch {}

      try {
        const models = await this.rpc.getAvailableModels();
        const scoped = filterScopedModels(models);
        this.state.availableModels = scoped.map((m: any) => ({
          provider: m.provider, id: m.id, name: m.name || m.id, thinkingLevel: undefined,
        }));
      } catch {}

      // Load session history
      try {
        const messages = await this.rpc.getMessages();
        if (messages && messages.length > 0) {
          this.state.streamHistory = messages.map((msg: any) => ({
            role: msg.role || '',
            text: msg.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') || '',
            streaming: false,
            timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : undefined,
          })).filter((m: any) => m.text);
          if (this.state.streamHistory.length > 50) {
            this.state.streamHistory.splice(0, this.state.streamHistory.length - 50);
          }
        }
      } catch {}
    } catch (err) {
      console.error(`[autere] User "${this.user}" failed to fetch initial state:`, err);
    }
  }

  private registerEventHandlers(): void {
    const s = this.state;
    const rpc = this.rpc;

    rpc.onEvent((event: any) => {
      if (event.type !== 'message_update') {
        console.log(`[autere] User "${this.user}" RPC event: ${event.type}`);
      }

      switch (event.type) {
        case 'session_start':
          this.handleSessionStart(event);
          break;
        case 'session_info_changed':
          this.handleSessionInfoChanged(event);
          break;
        case 'agent_start':
          s.sessionState.isStreaming = true;
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          break;
        case 'agent_end':
        case 'agent_settled':
          s.sessionState.isStreaming = false;
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          break;
        case 'message_update':
          this.handleMessageUpdate(event);
          break;
        case 'message_end':
          this.handleMessageEnd(event);
          break;
        case 'tool_execution_start':
          this.handleToolStart(event);
          break;
        case 'tool_execution_end':
          this.handleToolEnd(event);
          break;
        case 'model_select':
          this.handleModelSelect(event);
          break;
        case 'compaction_start':
          s.sessionState.compacting = true;
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          break;
        case 'compaction_end':
          s.sessionState.compacting = false;
          s.sessionState.isStreaming = false;
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          break;
        case 'turn_start':
          s.sessionState.isStreaming = true;
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          break;
      }

      this.touch();
    });
  }

  private handleSessionStart(event: any): void {
    const s = this.state;
    const rpc = this.rpc;

    rpc.getState().then(state => {
      if (state.sessionId) s.sessionState.sessionId = state.sessionId;
      if (state.sessionFile) s.sessionState.sessionFile = state.sessionFile;
      s.sessionState.sessionName = state.sessionName || null;
      s.sessionState.isStreaming = state.isStreaming;
      s.sessionState.compacting = state.isCompacting;
      if (state.model) {
        s.sessionState.model = {
          provider: state.model.provider,
          id: state.model.id,
          name: state.model.name || state.model.id,
        };
      }
      this.broadcast({ type: 'status', data: { ...s.sessionState } });
    }).catch(() => {});
  }

  private handleSessionInfoChanged(event: any): void {
    const s = this.state;
    if (event.sessionName !== undefined) {
      s.sessionState.sessionName = event.sessionName;
      this.broadcast({ type: 'status', data: { ...s.sessionState } });
    }
  }

  private handleMessageUpdate(event: any): void {
    const s = this.state;
    if (!event.message) return;

    const text = event.message.content
      ?.filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('') || '';

    if (text) {
      s.currentStreamText = text;
      s.currentStreamRole = event.message.role || '';

      const existingIdx = s.streamHistory.findIndex(
        (m: any) => m.streaming && m.role === s.currentStreamRole
      );

      if (existingIdx >= 0) {
        s.streamHistory[existingIdx] = {
          ...s.streamHistory[existingIdx],
          text,
        };
      } else {
        s.streamHistory.push({
          role: s.currentStreamRole,
          text,
          streaming: true,
          timestamp: Date.now(),
        });
      }

      this.broadcast({
        type: 'stream_history',
        data: s.streamHistory.slice(-50),
      });
    }
  }

  private handleMessageEnd(event: any): void {
    const s = this.state;
    if (!event.message) return;

    s.sessionState.messageCount++;

    const role = event.message.role || '';
    const text = event.message.content
      ?.filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('') || '';

    // Skip toolResult messages — they are added by handleToolEnd instead
    if (role === 'toolResult') {
      // Still update stats
      const usage = event.message.usage;
      if (usage) {
        if (usage.input) s.sessionStats.tokens.input = (s.sessionStats.tokens.input || 0) + usage.input;
        if (usage.output) s.sessionStats.tokens.output = (s.sessionStats.tokens.output || 0) + usage.output;
        if (usage.cacheRead) s.sessionStats.tokens.cacheRead = (s.sessionStats.tokens.cacheRead || 0) + usage.cacheRead;
        if (usage.cacheWrite) s.sessionStats.tokens.cacheWrite = (s.sessionStats.tokens.cacheWrite || 0) + usage.cacheWrite;
        if (usage.cost) s.sessionStats.cost = (s.sessionStats.cost || 0) + (usage.cost.total || 0);
      }
      this.broadcast({ type: 'stats', data: { ...s.sessionStats } });
      return;
    }

    // Update stream history
    const streamingIdx = s.streamHistory.findIndex(
      (m: any) => m.streaming && m.role === role
    );

    if (streamingIdx >= 0) {
      s.streamHistory[streamingIdx] = {
        ...s.streamHistory[streamingIdx],
        text,
        streaming: false,
        timestamp: Date.now(),
      };
    } else if (text) {
      s.streamHistory.push({
        role,
        text,
        streaming: false,
        timestamp: Date.now(),
      });
    }

    // Keep only last 50 messages
    if (s.streamHistory.length > 50) {
      s.streamHistory.splice(0, s.streamHistory.length - 50);
    }

    this.broadcast({
      type: 'stream_history',
      data: s.streamHistory.slice(-50),
    });

    // Update stats
    const usage = event.message.usage;
    if (usage) {
      if (usage.input) s.sessionStats.tokens.input = (s.sessionStats.tokens.input || 0) + usage.input;
      if (usage.output) s.sessionStats.tokens.output = (s.sessionStats.tokens.output || 0) + usage.output;
      if (usage.cacheRead) s.sessionStats.tokens.cacheRead = (s.sessionStats.tokens.cacheRead || 0) + usage.cacheRead;
      if (usage.cacheWrite) s.sessionStats.tokens.cacheWrite = (s.sessionStats.tokens.cacheWrite || 0) + usage.cacheWrite;
      if (usage.cost) s.sessionStats.cost = (s.sessionStats.cost || 0) + (usage.cost.total || 0);
    }

    this.broadcast({ type: 'stats', data: { ...s.sessionStats } });
    this.broadcast({ type: 'status', data: { ...s.sessionState } });

    this.rpc.getSessionStats().then(stats => {
      if (stats.contextUsage) s.sessionStats.contextUsage = stats.contextUsage;
      this.broadcast({ type: 'stats', data: { ...s.sessionStats } });
    }).catch(() => {});
  }

  private handleToolStart(event: any): void {
    const s = this.state;
    const cmd = this.formatToolArgs(event.toolName, event.args);
    s.activeTools.set(event.toolCallId, { name: event.toolName, args: event.args, cmd, startTime: Date.now() });
    this.broadcast({ type: 'tool_start', data: { id: event.toolCallId, name: event.toolName, cmd } });
  }

  private handleToolEnd(event: any): void {
    const s = this.state;
    const tool = s.activeTools.get(event.toolCallId);
    const cmd = tool?.cmd || '';
    const args = tool?.args || {};
    s.activeTools.delete(event.toolCallId);
    s.recentTools.unshift({ name: event.toolName, isError: event.isError, timestamp: Date.now(), args });
    if (s.recentTools.length > 5) s.recentTools.length = 5;
    this.broadcast({ type: 'tool_end', data: { id: event.toolCallId, name: event.toolName, isError: event.isError, cmd, recentTools: s.recentTools } });

    // Add tool result to stream history
    if (event.result || event.isError) {
      const toolName = event.toolName || 'tool';
      let text = '';

      // For edit tools: content.text as header, details.diff as body
      if (toolName === 'edit') {
        const header = event.result?.content
          ?.filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n') || '';
        const diff = event.result?.details?.diff || '';
        text = diff ? header + '\n\n' + diff : header;
      } else if (event.result?.content) {
        text = event.result.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n');
      }

      const isError = event.isError || false;
      const role = toolName === 'edit' ? 'edit' : 'toolResult';
      const prefix = isError ? `[${toolName} error]` : (toolName === 'edit' ? '' : `[${toolName}]`);
      const displayText = prefix ? (text ? prefix + ' ' + text : prefix) : text;
      if (displayText) {
        s.streamHistory.push({
          role,
          text: displayText,
          streaming: false,
          timestamp: Date.now(),
          isError,
        });
        if (s.streamHistory.length > 50) s.streamHistory.splice(0, s.streamHistory.length - 50);
        this.broadcast({ type: 'stream_history', data: s.streamHistory.slice(-50) });
      }
    }
  }

  private handleModelSelect(event: any): void {
    const s = this.state;
    if (event.model) {
      s.sessionState.model = {
        provider: event.model.provider,
        id: event.model.id,
        name: event.model.name || event.model.id,
      };
      this.broadcast({ type: 'status', data: { ...s.sessionState } });
    }
  }

  private formatToolArgs(name: string, args: any): string {
    if (!args) return '';
    if (name === 'bash' && typeof args.command === 'string') return args.command;
    if (name === 'read' && typeof args.path === 'string') return args.path;
    if (name === 'write' && typeof args.path === 'string') return args.path;
    if (name === 'edit' && typeof args.path === 'string') return args.path;
    for (const v of Object.values(args)) {
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return '';
  }
}
