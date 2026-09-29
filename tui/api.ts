import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { API } from '../src/shared/api-paths.js';
export { API };

const AUTERE_DIR = process.env.AUTERE_DIR || join(homedir(), '.autere');
const CONFIG_FILE = join(AUTERE_DIR, 'tui.json');

export interface Config {
  url: string;
  token: string;
}

export function loadConfig(): Config | null {
  try {
    if (existsSync(CONFIG_FILE)) {
      const c = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      if (c?.url && c?.token) return c;
    }
  } catch {}
  return null;
}

export function saveConfig(c: Config) {
  mkdirSync(join(CONFIG_FILE, '..'), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
}

export interface HistoryEntry {
  id: string | number;
  role: string; // user | assistant | thinking | toolCall | toolResult | edit | image | file | error
  text: string;
  streaming?: boolean;
  isError?: boolean;
  toolCall?: { name: string; cmd?: string };
  timestamp?: number;
}

export interface SessionState {
  sessionId?: string;
  sessionName?: string | null;
  model?: { id: string; name: string; provider: string } | null;
  isStreaming?: boolean;
  compacting?: boolean;
  steerPending?: number;
  followUpPending?: number;
  messageCount?: number;
  requestCount?: number;
}

export interface SessionStats {
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost?: number;
  contextUsage?: { usedFraction?: number } | null;
}

export interface SessionInfo {
  id: string;
  sessionName?: string | null;
  lastActivity: number;
  active?: boolean;
  streaming?: boolean;
  compacting?: boolean;
}

export class Api {
  readonly clientId = `tui-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;

  constructor(readonly base: string, public token: string) {}

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  private async unwrap(res: Response) {
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120) || res.statusText}`);
    const json: any = await res.json();
    if (!json.success) throw new Error(json.error || res.statusText);
    return json.data;
  }

  async get(path: string) {
    return this.unwrap(await fetch(this.base + path, { headers: this.headers() }));
  }

  async post(path: string, body: any) {
    return this.unwrap(await fetch(this.base + path, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }));
  }

  async put(path: string, body: any) {
    return this.unwrap(await fetch(this.base + path, {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }));
  }

  async verify(): Promise<boolean> {
    try {
      const res = await fetch(this.base + API.auth.status, { headers: this.headers() });
      const json: any = await res.json();
      return json.success && json.data?.authenticated;
    } catch {
      return false;
    }
  }

  static async login(base: string, user: string, password: string): Promise<Config> {
    const res = await fetch(base + API.auth.login, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, password }),
    });
    const json: any = await res.json();
    if (!json.success || !json.token) throw new Error(json.error || 'Login failed');
    return { url: base, token: json.token };
  }

  /** Consume the SSE stream; onEvent gets (type, payload, sessionId). */
  sse(onEvent: (type: string, data: any, sessionId?: string | null) => void, onDeath?: () => void) {
    (async () => {
      try {
        const res = await fetch(`${this.base}${API.events}?clientId=${this.clientId}`, { headers: this.headers() });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;
            try {
              const msg = JSON.parse(data);
              onEvent(msg.type, msg.data, msg.sessionId);
            } catch { /* malformed frame — skip */ }
          }
        }
      } catch { /* network death */ }
      onDeath?.();
    })();
  }
}
