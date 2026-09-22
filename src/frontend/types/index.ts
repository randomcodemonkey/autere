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
  compacting: boolean;
  /** Persona bound to the current session — null/undefined when none */
  persona?: { id: string; name: string } | null;
  steerPending?: number;
  followUpPending?: number;
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
  /** Total minus the reserve-% policy (backend-computed); omitted when no reserve is set. */
  effectiveWindow?: number;
}

export interface SessionStats {
  tokens: TokenUsage;
  cost: number;
  contextUsage: ContextUsage | null;
}

export interface StreamImage {
  mimeType: string;
  /** base64 payload (only present if the backend could not persist to disk) */
  data?: string;
  /** URL of the image served from the user's pi env (preferred) */
  url?: string;
}

export interface StreamMessage {
  role: string;
  text: string;
  streaming?: boolean;
  timestamp?: number;
  isError?: boolean;
  images?: StreamImage[];
  /** Present on 'file' pseudo-entries — a file shared via pi-filetools */
  file?: { name: string; savedName: string; size: number; mimeType?: string };
  /** Present on toolResult/toolCall entries — the connected tool call */
  toolCall?: { name: string; cmd: string };
  /** Live only: id used to replace a streaming toolCall with its result */
  toolCallId?: string;
  /** Optimistic frontend-only message — shown with a pending indicator until
   * the backend broadcast with the same text arrives. */
  pending?: boolean;
  /** Stable backend-assigned id — never changes across broadcasts, so React
   * keys (and thus expansion state, scroll anchoring) survive updates. */
  id?: string;
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
  statusText?: string;
  details: Record<string, any>;
  sections?: ExtensionSection[];
}

export interface AvailableModel {
  provider: string;
  id: string;
  name?: string;
  thinkingLevel?: string;
}

export interface SettingField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'toggle' | 'select' | 'list' | 'packages' | 'textarea' | 'perModel';
  placeholder?: string;
  options?: { value: string; label: string }[];
  description?: string;
  listPlaceholder?: string;
  listAddLabel?: string;
  /** Renderer config for type 'perModel': one control per entry of enabledModels */
  perModel?: {
    control: 'select' | 'number';
    options?: { value: string; label: string }[];
    min?: number;
    max?: number;
  };
}

export interface SettingSection {
  id: string;
  label: string;
  fields: SettingField[];
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

export interface SessionSearchResult extends SessionInfo {
  match?: 'name' | 'id' | 'content';
}

export interface SessionInfo {
  id: string;
  sessionFile: string;
  sessionName: string | null;
  parentSession: string | null;
  createdAt: number;
  lastActivity: number;
  cwd: string | null;
  /** Live flags: its pi process is running / its turn is in flight */
  active?: boolean;
  streaming?: boolean;
}

export type SSEEventType =
  | 'status'
  | 'stats'
  | 'stream_history'
  | 'history_upsert'
  | 'history_remove'
  | 'stream_delta'
  | 'message'
  | 'tool_start'
  | 'tool_end'
  | 'extensions'
  | 'models'
  | 'sessions'
  | 'new_session_creating'
  | 'navigate'
  | 'error'
  | 'heartbeat';
export interface SSEMessage {
  type: SSEEventType;
  data: any;
  /** Session the event belongs to, when known (e.g. stream_history) */
  sessionId?: string | null;
}

// ── Scheduled tasks ──

export interface ScheduledTask {
  id: string;
  name: string;
  /** 5-field cron expression (minute hour dom month dow) */
  schedule: string;
  prompt: string;
  /** Optional model override for this task's runs */
  model?: string;
  seedScript?: string;
  resultScript?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type TaskRunStatus = 'running' | 'success' | 'error';

export interface TaskRunRecord {
  runId: string;
  taskId: string;
  taskName: string;
  trigger: 'schedule' | 'manual';
  startedAt: number;
  finishedAt?: number;
  status: TaskRunStatus;
  error?: string;
}

export interface TaskRunLog extends TaskRunRecord {
  prompt: string;
  seedOutput?: string;
  agentResult?: string;
  resultScriptOutput?: string;
  /** Progress lines — t is UTC epoch ms, formatted in the user's locale/tz on render */
  log: Array<{ t: number; line: string }>;
}

// ── User management ──

export type DirAccess = 'read' | 'rw';

export interface AllowedDir {
  path: string;
  access: DirAccess;
}

export interface ManagedUser {
  username: string;
  role: 'chat' | 'control' | 'admin';
  mustChangePassword: boolean;
  allowedDirs: AllowedDir[];
}
