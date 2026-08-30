export interface SessionState {
  model: { provider: string; id: string; name: string } | null;
  thinkingLevel: string;
  isStreaming: boolean;
  messageCount: number;
  requestCount: number;
  pendingMessageCount: number;
  sessionFile: string | null;
  sessionId: string | null;
  sessionName: string | null;
  connected: boolean;
  startTime: number;
  externalActivity: boolean;
  compacting: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export interface SessionStats {
  tokens: TokenUsage;
  cost: number;
  contextUsage: ContextUsage | null;
}

export interface StreamMessage {
  role: string;
  text: string;
  streaming?: boolean;
  timestamp?: number;
  isError?: boolean;
}

export interface ActiveTool {
  id: string;
  name: string;
  cmd: string;
  args: any;
  startTime: number;
}

export interface RecentTool {
  name: string;
  isError: boolean;
  timestamp: number;
  args: any;
}

export interface ExtensionSection {
  header: string;
  items: Record<string, any>[];
}

export interface ExtensionInfo {
  name: string;
  displayName: string;
  configPath: string;
  hasConfig: boolean;
  status: string;
  details: Record<string, any>;
  sections?: ExtensionSection[];
}

export interface AvailableModel {
  provider: string;
  id: string;
  name?: string;
  thinkingLevel?: string;
}

export interface SessionInfo {
  id: string;
  sessionFile: string;
  sessionName: string | null;
  parentSession: string | null;
  createdAt: number;
  lastActivity: number;
  cwd: string | null;
}

export type SSEEventType =
  | 'status'
  | 'stats'
  | 'stream_history'
  | 'message'
  | 'tool_start'
  | 'tool_end'
  | 'extensions'
  | 'models'
  | 'sessions'
  | 'new_session_creating'
  | 'navigate'
  | 'heartbeat';

export interface SSEMessage {
  type: SSEEventType;
  data: any;
}
