/**
 * AG-UI protocol adapter.
 *
 * AG-UI is a frontend event protocol: the client POSTs a RunAgentInput
 * (`threadId`, `runId`, `messages`, `tools`, `context`, `state`,
 * `forwardedProps`) and reads the run back as a Server-Sent-Events stream
 * (`RUN_STARTED` … `RUN_FINISHED`/`RUN_ERROR`). It has no thread CRUD, so
 * autere owns the mapping:
 *
 *   threadId  ->  pi session file  (agui-threads.json, per user)
 *
 * An unknown threadId creates a new pi session; a known one resumes it (the
 * process is respawned on demand after the idle timeout, history intact).
 * Conversation history lives in the pi session, NOT in the request — only the
 * trailing user message is sent to pi. Model/tool output is translated from
 * the events UserSession already broadcasts for the dashboard.
 *
 * Not supported: client-defined tools (`RunAgentInput.tools`) and
 * human-in-the-loop interrupts. pi has no frontend-tool callback, so calling
 * back into the browser would need a pause/resume mechanism it does not
 * expose. `context` and inline file parts ARE relayed to the agent.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { USER_SETTINGS_DIR } from './constants.js';
import { getPiEnvDir } from './pi-env.js';
import { listPersonas, setActivePersona } from './personas.js';
import type { ProcessManager } from './process-manager.js';
import type { RpcImage } from './rpc-client.js';
import type { UserSession } from './user-session.js';
import { log } from './logger.js';
import { sanitizeUserName } from '../shared/format.js';

// ── Limits (mirror the /session/messages attachment rules) ──

const MAX_ID_LENGTH = 200;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 32_000;
const MAX_CONTEXT_ENTRIES = 50;
const MAX_THREADS = 200;
const SSE_BACKLOG_LIMIT = 8 * 1024 * 1024;
const RUN_END_FALLBACK_MS = 2000;

// ── RunAgentInput ──

export interface AguiAttachment {
  name: string;
  mimeType: string;
  /** Decoded bytes */
  data: Buffer;
}

export interface AguiRunInput {
  threadId: string;
  runId: string;
  /** Text of the trailing user message */
  text: string;
  images: AguiAttachment[];
  files: AguiAttachment[];
  context: { description: string; value: string }[];
  props: Record<string, any>;
}

export class AguiInputError extends Error {}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Sanitize a client-supplied attachment name for the uploads dir. */
function safeFileName(name: string, fallback: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80);
  return cleaned || fallback;
}

/**
 * Validate a RunAgentInput and pull out what pi needs. Media parts are
 * base64-decoded here so a malformed/oversized attachment fails before any
 * session work happens.
 */
export function parseRunInput(body: unknown): AguiRunInput {
  if (!isObject(body)) throw new AguiInputError('Body must be a JSON object');
  const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : '';
  const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
  if (!threadId) throw new AguiInputError('threadId is required');
  if (!runId) throw new AguiInputError('runId is required');
  if (threadId.length > MAX_ID_LENGTH || runId.length > MAX_ID_LENGTH) {
    throw new AguiInputError(`threadId and runId must be at most ${MAX_ID_LENGTH} characters`);
  }
  if (!Array.isArray(body.messages)) throw new AguiInputError('messages must be an array');

  const lastUser = [...body.messages].reverse().find((m: any) => m?.role === 'user');
  if (!lastUser) throw new AguiInputError('messages must contain a user message');

  let text = '';
  const images: AguiAttachment[] = [];
  const files: AguiAttachment[] = [];
  const content = lastUser.content;

  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!isObject(part)) continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        text += part.text;
        continue;
      }
      const source = part.source;
      if (!isObject(source) || source.type !== 'data' || typeof source.value !== 'string') continue;
      const mimeType = typeof source.mimeType === 'string' ? source.mimeType : '';
      const declaredName = typeof part.metadata?.filename === 'string' ? part.metadata.filename : '';
      const raw = source.value.startsWith('data:') ? source.value.replace(/^data:[^;]+;base64,/, '') : source.value;
      const data = Buffer.from(raw, 'base64');
      if (data.length === 0) continue;
      if (mimeType.startsWith('image/')) {
        if (images.length >= MAX_IMAGES) throw new AguiInputError(`At most ${MAX_IMAGES} image attachments are allowed`);
        if (data.length > MAX_IMAGE_BYTES) throw new AguiInputError('Image too large (max 8 MB)');
        const ext = (mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
        images.push({ name: safeFileName(declaredName, `image-${images.length + 1}.${ext}`), mimeType, data });
      } else {
        if (files.length >= MAX_FILES) throw new AguiInputError(`At most ${MAX_FILES} file attachments are allowed`);
        if (data.length > MAX_FILE_BYTES) throw new AguiInputError('File too large (max 10 MB)');
        files.push({ name: safeFileName(declaredName, `attachment-${files.length + 1}`), mimeType: mimeType || 'application/octet-stream', data });
      }
    }
  } else if (content !== undefined) {
    throw new AguiInputError('The user message content must be a string or an array of parts');
  }

  if (!text.trim() && images.length === 0 && files.length === 0) {
    throw new AguiInputError('The user message is empty');
  }

  // Ambient context for the run (page/file/selection info the client wants
  // the agent to take into account). Bounded so a client cannot blow up the
  // agent's context with one request.
  const context: { description: string; value: string }[] = [];
  if (Array.isArray(body.context)) {
    let budget = MAX_CONTEXT_CHARS;
    for (const entry of body.context) {
      if (context.length >= MAX_CONTEXT_ENTRIES || budget <= 0) break;
      if (!isObject(entry) || typeof entry.value !== 'string' || !entry.value.trim()) continue;
      const value = entry.value.slice(0, budget);
      budget -= value.length;
      context.push({
        description: typeof entry.description === 'string' ? entry.description.slice(0, 200) : '',
        value,
      });
    }
  }

  const props = isObject(body.forwardedProps) ? body.forwardedProps : {};

  return { threadId, runId, text, images, files, context, props };
}

/** Context block appended to the prompt. Pure for the self-check. */
export function formatContextBlock(context: AguiRunInput['context']): string {
  if (context.length === 0) return '';
  const entries = context.map((c) => {
    const tag = c.description ? ` description="${c.description.replace(/["<>\n]/g, ' ')}"` : '';
    return `<context${tag}>\n${c.value}\n</context>`;
  });
  return [
    '<agui-run-context>',
    'Ambient context supplied by the client application for this request (page state, selected file, ...). Use it when it is relevant to the task; it is not a user instruction.',
    ...entries,
    '</agui-run-context>',
  ].join('\n');
}

/** Prompt text for pi from the trailing user message + context + attachments. */
export function formatPrompt(input: AguiRunInput, filePaths: string[]): string {
  const parts = [input.text.trim()];
  const context = formatContextBlock(input.context);
  if (context) parts.push(context);
  if (filePaths.length > 0) {
    parts.push([
      '[Attached files from the client application saved to:',
      ...filePaths.map((p) => `- ${p}`),
      'Read them with your file tools (read, bash, ...) — do not search for the attachment.]',
    ].join('\n'));
  }
  return parts.filter(Boolean).join('\n\n');
}

// ── Thread registry: threadId -> pi session file ──

interface ThreadRecord {
  sessionFile: string;
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

function threadsFile(user: string): string {
  return join(USER_SETTINGS_DIR, sanitizeUserName(user), 'agui-threads.json');
}

function readThreads(user: string): Record<string, ThreadRecord> {
  try {
    const parsed = JSON.parse(readFileSync(threadsFile(user), 'utf-8'));
    if (!isObject(parsed)) return {};
    const out: Record<string, ThreadRecord> = {};
    for (const [id, rec] of Object.entries(parsed)) {
      if (!isObject(rec) || typeof rec.sessionFile !== 'string') continue;
      out[id] = {
        sessionFile: rec.sessionFile,
        sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : null,
        createdAt: Number(rec.createdAt) || Date.now(),
        updatedAt: Number(rec.updatedAt) || Date.now(),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Upsert one thread. Read-modify-write is synchronous, so concurrent runs
 *  cannot interleave it. Dead session files are pruned here (deleted
 *  sessions / moved-to-trash), keeping the file bounded. */
function bindThread(user: string, threadId: string, record: Omit<ThreadRecord, 'createdAt' | 'updatedAt'>): void {
  const all = readThreads(user);
  const prev = all[threadId];
  all[threadId] = {
    ...record,
    createdAt: prev?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  // Prune dead entries (deleted sessions) and keep the file bounded. The
  // record upserted here is kept unconditionally: a brand-new pi session only
  // materialises its JSONL on the first message, which is still ahead of us.
  const alive = Object.entries(all)
    .filter(([id, rec]) => id === threadId || existsSync(rec.sessionFile))
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_THREADS);
  const path = threadsFile(user);
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(alive), null, 2), 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    log.userSession.error('Failed to save AG-UI thread binding:', err);
  }
}

/** Resolve `forwardedProps.sessionFile` (a pi session id or a path) inside the
 *  caller's own pi env — never an arbitrary filesystem path. */
function resolveSessionRef(user: string, value: string, pm: ProcessManager): string | null {
  const byId = pm.findSession(user, value, new Set());
  if (byId?.sessionFile) return byId.sessionFile;
  try {
    const root = realpathSync(join(getPiEnvDir(user), 'sessions'));
    const abs = realpathSync(value);
    return abs.startsWith(root + sep) ? abs : null;
  } catch {
    return null;
  }
}

// ── AG-UI message mapping (MESSAGES_SNAPSHOT) ──

function mediaParts(content: any[]): any[] {
  const parts: any[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'image' && typeof block.data === 'string' && block.mimeType) {
      parts.push({ type: 'image', source: { type: 'data', value: block.data, mimeType: block.mimeType } });
    }
  }
  return parts;
}

/**
 * Convert pi messages (rpc.getMessages() / session-file entries) to AG-UI
 * messages. Used only for the opt-in MESSAGES_SNAPSHOT, so it favours a
 * faithful text/tool representation over rendering extras (edits, files).
 */
export function toAguiMessages(rawMessages: any[]): any[] {
  const out: any[] = [];
  const toolCallIds = new Set<string>();
  for (const [i, raw] of rawMessages.entries()) {
    const msg = raw?.message ?? raw;
    if (!isObject(msg) || !msg.role) continue;
    if (msg.customType) continue;
    const id = `agui-${i}`;
    if (msg.role === 'user') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const text = Array.isArray(msg.content)
        ? msg.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('')
        : (typeof msg.content === 'string' ? msg.content : '');
      const media = mediaParts(content);
      out.push({ id, role: 'user', content: media.length > 0 ? [{ type: 'text', text }, ...media] : text });
    } else if (msg.role === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      let text = '';
      const toolCalls: any[] = [];
      for (const block of blocks) {
        if (!isObject(block)) continue;
        if (block.type === 'text') {
          text += block.text || '';
        } else if (block.type === 'thinking' && block.thinking) {
          out.push({ id: `${id}-reasoning-${out.length}`, role: 'reasoning', content: block.thinking });
        } else if (block.type === 'toolCall' && block.id) {
          toolCallIds.add(block.id);
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name || 'tool', arguments: JSON.stringify(block.arguments ?? block.args ?? {}) },
          });
        }
      }
      out.push({ id, role: 'assistant', ...(text ? { content: text } : {}), ...(toolCalls.length ? { toolCalls } : {}) });
    } else if (msg.role === 'toolResult') {
      out.push({
        id,
        role: 'tool',
        toolCallId: msg.toolCallId || `unknown-${i}`,
        content: Array.isArray(msg.content)
          ? msg.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('')
          : String(msg.content ?? ''),
        ...(msg.isError ? { error: 'Tool call failed' } : {}),
      });
    } else if (msg.role === 'system' || msg.role === 'developer') {
      out.push({
        id,
        role: msg.role,
        content: Array.isArray(msg.content)
          ? msg.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('')
          : String(msg.content ?? ''),
      });
    }
  }
  return out;
}

// ── Live event translation ──

interface OpenStream {
  id: string;
  sent: number;
}

/**
 * Turns the events UserSession broadcasts into AG-UI events. Keeps only the
 * translation state (which message is open, how much text was already sent);
 * the run lifecycle (start/finish/error) is owned by the caller.
 */
export class AguiTranslator {
  private text: OpenStream | null = null;
  private reasoning: OpenStream | null = null;
  private lastAssistantId: string | null = null;
  private lastState = '';
  private toolResults = new Set<string>();
  private startedTools = new Set<string>();
  private readonly stateSnapshot: () => any;

  constructor(stateSnapshot: () => any) {
    this.stateSnapshot = stateSnapshot;
  }

  /** Translate one autere session event into zero or more AG-UI events. */
  onEvent(event: any): any[] {
    const out: any[] = [];
    switch (event?.type) {
      case 'stream_delta': {
        const data = event.data || {};
        if (data.role === 'assistant') this.textChunk(out, data);
        else if (data.role === 'thinking') this.reasoningChunk(out, data);
        break;
      }
      case 'history_upsert': {
        for (const entry of Array.isArray(event.data) ? event.data : []) {
          if (entry?.role === 'toolResult' && entry.toolCallId) {
            if (this.toolResults.has(entry.toolCallId)) continue;
            this.toolResults.add(entry.toolCallId);
            out.push({
              type: 'TOOL_CALL_RESULT',
              messageId: `agui-tool-${entry.toolCallId}`,
              toolCallId: entry.toolCallId,
              content: typeof entry.text === 'string' ? entry.text : '',
              role: 'tool',
              timestamp: Date.now(),
            });
          } else if (entry?.role === 'assistant' && entry.streaming === false) {
            // Final text can arrive without deltas (resumed/one-shot message);
            // never lose it.
            if (entry.text) this.textChunk(out, { id: entry.id, text: entry.text });
            this.closeText(out);
          } else if (entry?.role === 'thinking' && entry.streaming === false) {
            this.closeReasoning(out);
          }
        }
        break;
      }
      case 'tool_start': {
        const data = event.data || {};
        if (!data.id) break;
        // Assistant text/reasoning never coexists with a tool call in AG-UI.
        this.closeText(out);
        this.closeReasoning(out);
        this.startedTools.add(data.id);
        out.push({
          type: 'TOOL_CALL_START',
          toolCallId: data.id,
          toolCallName: data.name || 'tool',
          ...(this.lastAssistantId ? { parentMessageId: this.lastAssistantId } : {}),
          timestamp: Date.now(),
        });
        out.push({
          type: 'TOOL_CALL_ARGS',
          toolCallId: data.id,
          delta: JSON.stringify(data.args ?? {}),
          timestamp: Date.now(),
        });
        break;
      }
      case 'tool_end': {
        const data = event.data || {};
        if (!data.id || !this.startedTools.delete(data.id)) break;
        out.push({ type: 'TOOL_CALL_END', toolCallId: data.id, timestamp: Date.now() });
        break;
      }
      case 'status':
      case 'stats': {
        const snapshot = this.stateSnapshot();
        const json = JSON.stringify(snapshot);
        if (json !== this.lastState) {
          this.lastState = json;
          out.push({ type: 'STATE_SNAPSHOT', snapshot, timestamp: Date.now() });
        }
        break;
      }
    }
    return out;
  }

  /** Close any open text/reasoning message (call before RUN_FINISHED). */
  close(): any[] {
    const out: any[] = [];
    this.closeText(out);
    this.closeReasoning(out);
    return out;
  }

  private textChunk(out: any[], data: any): void {
    const id = typeof data.id === 'string' && data.id ? data.id : 'assistant';
    const text = typeof data.text === 'string' ? data.text : '';
    if (!this.text || this.text.id !== id) {
      this.closeText(out);
      this.text = { id, sent: 0 };
      this.lastAssistantId = id;
      out.push({ type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant', timestamp: Date.now() });
    }
    const delta = text.slice(this.text.sent);
    if (delta) {
      out.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta, timestamp: Date.now() });
      this.text.sent = text.length;
    }
  }

  private reasoningChunk(out: any[], data: any): void {
    const id = typeof data.id === 'string' && data.id ? data.id : 'reasoning';
    const text = typeof data.text === 'string' ? data.text : '';
    if (!this.reasoning || this.reasoning.id !== id) {
      this.closeReasoning(out);
      this.reasoning = { id, sent: 0 };
      out.push({ type: 'REASONING_MESSAGE_START', messageId: id, role: 'reasoning', timestamp: Date.now() });
    }
    const delta = text.slice(this.reasoning.sent);
    if (delta) {
      out.push({ type: 'REASONING_MESSAGE_CONTENT', messageId: id, delta, timestamp: Date.now() });
      this.reasoning.sent = text.length;
    }
  }

  private closeText(out: any[]): void {
    if (!this.text) return;
    out.push({ type: 'TEXT_MESSAGE_END', messageId: this.text.id, timestamp: Date.now() });
    this.text = null;
  }

  private closeReasoning(out: any[]): void {
    if (!this.reasoning) return;
    out.push({ type: 'REASONING_MESSAGE_END', messageId: this.reasoning.id, timestamp: Date.now() });
    this.reasoning = null;
  }
}

// ── HTTP handler ──

export interface AguiRunOptions {
  user: string;
  req: IncomingMessage;
  res: ServerResponse;
  body: unknown;
  /** The request authenticated with `Authorization: Bearer` (CORS/CSRF gate) */
  bearer: boolean;
  pm: ProcessManager;
  /** Same validation the new-session route uses (admin-only workdirs) */
  validateWorkdirs?: (user: string, raw: unknown[]) => { list?: string[]; error?: string; status?: number };
}

function json(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, error }));
}

function originHost(origin: string): string {
  try { return new URL(origin).host; } catch { return ''; }
}

function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
}

/** Runs currently in flight, keyed by user+thread. Guards the sliver between
 *  two requests both reading `isStreaming === false` for the same thread. */
const activeRuns = new Set<string>();

/** One run: owns the SSE response, the subscription and the lifecycle. */
export async function handleAguiRun(opts: AguiRunOptions): Promise<void> {
  const { user, req, res, pm } = opts;

  // Cross-origin browser clients must use a bearer token: a cookie-authed
  // cross-site POST would be CSRF-able.
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (origin && !opts.bearer && originHost(origin) !== (req.headers.host || '')) {
    json(res, 403, 'Cross-origin AG-UI requests require a bearer token');
    return;
  }

  let input: AguiRunInput;
  try {
    input = parseRunInput(opts.body);
  } catch (err: any) {
    json(res, 400, err?.message || 'Invalid RunAgentInput');
    return;
  }

  const props = input.props;

  // ── Resolve thread -> pi session (create on first run) ──
  const threads = readThreads(user);
  let record: ThreadRecord | undefined = threads[input.threadId];
  if (record && !existsSync(record.sessionFile)) record = undefined; // deleted session
  let sessionFile: string | null = record?.sessionFile ?? null;

  if (!sessionFile && props.sessionFile !== undefined) {
    if (typeof props.sessionFile !== 'string' || !props.sessionFile.trim()) {
      json(res, 400, 'forwardedProps.sessionFile must be a session id or path');
      return;
    }
    const resolved = resolveSessionRef(user, props.sessionFile.trim(), pm);
    if (!resolved) {
      json(res, 400, 'forwardedProps.sessionFile does not belong to this user');
      return;
    }
    sessionFile = resolved;
  }
  /** This run starts a brand new pi session (not a resumed/adopted one). */
  const newSession = !sessionFile;

  // workdirs only make sense for a brand new session (admin-only)
  let workdirs: string[] | undefined;
  if (!sessionFile) {
    const rawWorkdirs = Array.isArray(props.workdirs)
      ? props.workdirs
      : (props.workdir !== undefined ? [props.workdir] : []);
    if (rawWorkdirs.length > 0) {
      const check = opts.validateWorkdirs?.(user, rawWorkdirs);
      if (!check || check.error) {
        json(res, check?.status ?? 403, check?.error || 'workdirs are not allowed');
        return;
      }
      workdirs = check.list;
    }
  }

  // Validate the persona before spawning anything.
  const personaId = typeof props.personaId === 'string' ? props.personaId.trim() : '';
  const persona = personaId ? listPersonas(user).find((p) => p.id === personaId) : undefined;
  if (personaId && !persona) {
    json(res, 400, `Unknown persona: ${personaId}`);
    return;
  }

  const runKey = `${user}::${input.threadId}`;
  const releaseRun = () => { activeRuns.delete(runKey); };
  if (activeRuns.has(runKey)) {
    startSse(res);
    writeSse(res, { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId, timestamp: Date.now() });
    writeSse(res, { type: 'RUN_ERROR', message: 'The agent is already running a turn for this thread', code: 'agent_busy', timestamp: Date.now() });
    res.end();
    return;
  }
  activeRuns.add(runKey);

  let session: UserSession;
  try {
    session = await pm.getOrCreate(user, sessionFile, workdirs ? { cwd: workdirs[0], workdirs } : {});
  } catch (err: any) {
    releaseRun();
    log.http.error('AG-UI session spawn failed:', err);
    startSse(res);
    writeSse(res, { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId, timestamp: Date.now() });
    writeSse(res, { type: 'RUN_ERROR', message: `Failed to create session: ${err?.message || err}`, code: 'spawn_failed', timestamp: Date.now() });
    res.end();
    return;
  }

  const file = session.routedSessionFile();
  if (!file) {
    releaseRun();
    startSse(res);
    writeSse(res, { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId, timestamp: Date.now() });
    writeSse(res, { type: 'RUN_ERROR', message: 'pi started a session but reported no session file', code: 'session_unavailable', timestamp: Date.now() });
    res.end();
    return;
  }
  const sessionId = session.state.sessionState.sessionId || null;

  // One pi turn at a time — pi would leave a second prompt queued forever.
  if (session.state.sessionState.isStreaming) {
    releaseRun();
    startSse(res);
    writeSse(res, { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId, timestamp: Date.now() });
    writeSse(res, { type: 'RUN_ERROR', message: 'The agent is already running a turn for this thread', code: 'agent_busy', timestamp: Date.now() });
    res.end();
    return;
  }

  bindThread(user, input.threadId, { sessionFile: file, sessionId });

  // First-run setup (persona/name only for a session this thread created);
  // an explicit model applies to both new and resumed threads.
  if (newSession) {
    if (persona) {
      setActivePersona(user, file, persona);
      session.state.sessionState.persona = { id: persona.id, name: persona.name };
    }
    if (typeof props.sessionName === 'string' && props.sessionName.trim()) {
      try { await session.rpc.setSessionName(props.sessionName.trim().slice(0, 200)); }
      catch (err) { log.http.error('AG-UI setSessionName failed:', err); }
    }
  }
  if (typeof props.model === 'string' && props.model.includes('/')) {
    try {
      const [provider, ...rest] = props.model.split('/');
      await session.rpc.setModel(provider, rest.join('/'));
    } catch (err) { log.http.error('AG-UI setModel failed:', err); }
  }

  // ── Attachments: save to the env, then reference them in the prompt ──
  const rpcImages: RpcImage[] = [];
  const filePaths: string[] = [];
  if (input.images.length > 0 || input.files.length > 0) {
    try {
      const uploads = join(session.getEnvDir(), 'uploads');
      mkdirSync(uploads, { recursive: true });
      for (const img of input.images) {
        const ext = (img.mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
        const name = `hist-${createHash('sha1').update(img.data).digest('hex').slice(0, 16)}.${ext}`;
        const target = join(uploads, name);
        if (!existsSync(target)) writeFileSync(target, img.data);
        session.pushImageEntry(name, img.mimeType);
        rpcImages.push({ type: 'image', data: img.data.toString('base64'), mimeType: img.mimeType });
      }
      for (const f of input.files) {
        const savedName = `file-${createHash('sha1').update(f.data).digest('hex').slice(0, 16)}-${f.name}`;
        const target = join(uploads, savedName);
        if (!existsSync(target)) writeFileSync(target, f.data);
        session.pushFileEntry(f.name, savedName, f.data.length, f.mimeType);
        filePaths.push(target);
      }
    } catch (err) {
      log.http.error('AG-UI attachment save failed:', err);
    }
  }

  // ── Run stream ──
  const startTokens = { ...session.state.sessionStats.tokens };
  const translator = new AguiTranslator(() => ({
    threadId: input.threadId,
    runId: input.runId,
    sessionId: session.state.sessionState.sessionId,
    sessionName: session.state.sessionState.sessionName,
    model: session.state.sessionState.model,
    streaming: !!session.state.sessionState.isStreaming,
    compacting: !!session.state.sessionState.compacting,
    tokens: { ...session.state.sessionStats.tokens },
    cost: session.state.sessionStats.cost,
    contextUsage: session.state.sessionStats.contextUsage,
  }));

  const usage = () => {
    const end = session.state.sessionStats.tokens;
    const model = session.state.sessionState.model;
    const delta = {
      inputTokens: Math.max(0, (end.input || 0) - (startTokens.input || 0)),
      outputTokens: Math.max(0, (end.output || 0) - (startTokens.output || 0)),
      cachedInputTokens: Math.max(0, (end.cacheRead || 0) - (startTokens.cacheRead || 0)),
      cacheWriteInputTokens: Math.max(0, (end.cacheWrite || 0) - (startTokens.cacheWrite || 0)),
    };
    if (!delta.inputTokens && !delta.outputTokens) return undefined;
    return [{
      ...(model?.provider ? { provider: model.provider } : {}),
      ...(model?.id ? { model: model.id } : {}),
      ...delta,
      totalTokens: delta.inputTokens + delta.outputTokens,
    }];
  };

  let done = false;
  let unsubscribe = () => {};
  let offExit = () => {};
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let fallback: ReturnType<typeof setTimeout> | null = null;

  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    if (fallback) clearTimeout(fallback);
    heartbeat = null;
    fallback = null;
  };

  const end = () => {
    if (done) return;
    done = true;
    stopHeartbeat();
    unsubscribe();
    offExit();
    try { res.end(); } catch {}
    releaseRun();
  };

  const finishOk = () => {
    if (done) return;
    for (const event of translator.close()) writeSse(res, event);
    const runUsage = usage();
    writeSse(res, {
      type: 'RUN_FINISHED',
      threadId: input.threadId,
      runId: input.runId,
      ...(runUsage ? { usage: runUsage } : {}),
      timestamp: Date.now(),
    });
    end();
  };

  const finishError = (message: string, code = 'run_failed') => {
    if (done) return;
    for (const event of translator.close()) writeSse(res, event);
    const runUsage = usage();
    writeSse(res, {
      type: 'RUN_ERROR',
      message,
      code,
      ...(runUsage ? { usage: runUsage } : {}),
      timestamp: Date.now(),
    });
    end();
  };

  const armFallback = () => {
    if (fallback || done) return;
    // agent_settled normally arrives right after agent_end; this only covers
    // a pi that never sends it.
    fallback = setTimeout(() => finishOk(), RUN_END_FALLBACK_MS);
  };

  const emit = (event: any) => {
    for (const translated of translator.onEvent(event)) writeSse(res, translated);
    if (event?.type !== 'status') return;
    if (event.data?.isStreaming) {
      if (fallback) { clearTimeout(fallback); fallback = null; }
    } else {
      armFallback();
    }
  };

  startSse(res);
  writeSse(res, {
    type: 'RUN_STARTED',
    threadId: input.threadId,
    runId: input.runId,
    timestamp: Date.now(),
  });
  // Initial state snapshot (no run-end fallback for this one: the turn has
  // not started yet).
  for (const translated of translator.onEvent({ type: 'status' })) writeSse(res, translated);

  // A client that lost/never had the conversation can ask for it explicitly.
  if (props.historySnapshot === true) {
    try {
      const messages = await session.rpc.getMessages();
      writeSse(res, { type: 'MESSAGES_SNAPSHOT', messages: toAguiMessages(messages), timestamp: Date.now() });
    } catch (err) {
      log.http.error('AG-UI history snapshot failed:', err);
    }
  }

  // Subscribe BEFORE prompting so the very first delta is not lost.
  unsubscribe = session.subscribe((event) => {
    if (done) return;
    if (event?.type === 'turn_settled') { finishOk(); return; }
    if (event?.type === 'error') {
      // Not a run failure (e.g. a failed auto-compaction) — surface it as a
      // custom event and let the turn finish normally.
      writeSse(res, { type: 'CUSTOM', name: 'autere.error', value: { message: String(event.data?.message || 'Agent error') }, timestamp: Date.now() });
      return;
    }
    try { emit(event); } catch (err) {
      log.http.error('AG-UI event translation failed:', err);
    }
  });
  offExit = session.rpc.onProcessExit((err) => finishError(err?.message || 'pi process exited', 'process_exit'));

  heartbeat = setInterval(() => {
    if (done) return;
    if (res.writableLength > SSE_BACKLOG_LIMIT) { finishError('Client is not reading the stream', 'backpressure'); return; }
    try { res.write(': ping\n\n'); } catch { end(); }
  }, 20_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  // Client abort (AG-UI `abortRun()` aborts the fetch) cancels the turn —
  // there is no cancel RPC in the protocol. Opt out with
  // forwardedProps.abortOnDisconnect: false.
  res.on('close', () => {
    const aborted = !done;
    end();
    if (aborted && props.abortOnDisconnect !== false) {
      session.rpc.abort().catch((err) => log.http.error('AG-UI abort failed:', err));
    }
  });

  const prompt = formatPrompt(input, filePaths);
  try {
    session.addUserEntry(prompt);
    await session.rpc.prompt(prompt, rpcImages.length > 0 ? rpcImages : undefined);
  } catch (err: any) {
    log.http.error('AG-UI prompt failed:', err);
    finishError(err?.message || 'Prompt failed');
  }
}

/** Write one AG-UI event as an SSE frame. */
function writeSse(res: ServerResponse, event: any): void {
  if (res.writableEnded) return;
  try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch (err) {
    log.userSession.error('AG-UI SSE write failed:', err);
  }
}
