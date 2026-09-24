// ── Extension info types ──

/** A generic list section for extension details modal */
export interface ExtensionSection {
  /** Section header text */
  header: string;
  /** List of objects to display — each object's keys become columns */
  items: Record<string, any>[];
}

export interface ExtensionInfo {
  name: string;
  displayName: string;
  configPath: string | null;
  hasConfig: boolean;
  /** Machine-readable state: 'ok' | 'error' | 'neutral' — drives dot/badge color */
  status: string;
  /** Human-readable label (e.g. 'Connected', 'Available') — backend-decided */
  statusText: string;
  details: Record<string, any>;
  /** Optional sections for the details modal (generic list-of-objects view) */
  sections?: ExtensionSection[];
}

/** A handler for a named extension that can provide custom status logic. */
export interface ExtensionHandler {
  /** Unique extension name (matches package name or local extension id) */
  name: string;
  /** Display name for the extension */
  displayName: string;
  /** Known config file paths to check (in priority order) */
  configPaths?: string[];
  /**
   * Called to enrich the extension info with custom status/details.
   * Return the modified info, or null to skip this extension.
   */
  enrich(info: ExtensionInfo): Promise<ExtensionInfo> | ExtensionInfo;
}

// ── Session types ──

export interface SessionInfo {
  id: string;
  sessionFile: string;
  sessionName: string | null;
  parentSession: string | null;
  createdAt: number;
  lastActivity: number;
  cwd: string | null;
  /** Live flags stamped by ProcessManager.listSessions */
  active?: boolean;
  streaming?: boolean;
  /** Compact in progress */
  compacting?: boolean;
}

// ── Stream history types ──

export interface StreamEntry {
  role: string;
  text: string;
  streaming?: boolean;
  timestamp?: number;
  isError?: boolean;
}

// ── Message types ──

export interface MessagePreview {
  role: string;
  timestamp: string;
  preview: string;
}

// ── Tool types ──

export interface ToolEntry {
  name: string;
  isError: boolean;
  timestamp: number;
  args: any;
}

// ── Stats types ──

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionStats {
  tokens: TokenUsage;
  cost: number;
  contextUsage: {
    tokens: number;
    contextWindow: number;
    percent: number;
    /** Total minus the reserve-% policy (pi-token-reserve extension); omitted when no reserve is set. */
    effectiveWindow?: number;
  } | null;
}

export interface SessionUsageResult {
  tokens: TokenUsage;
  /** All message entries (user + assistant + toolResult), incl. compacted-away ones */
  messageCount: number;
  /** Assistant messages = LLM requests */
  requestCount: number;
  /** Estimated cost: pi's per-message figure when present, else price() fallback */
  cost: number;
}