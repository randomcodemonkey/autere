/**
 * RPC Client wrapper for autere.
 *
 * Uses the RpcClient from @earendil-works/pi-coding-agent to spawn pi
 * in RPC mode and communicate via JSON lines on stdin/stdout.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import type {
  RpcCommand,
  RpcResponse,
  RpcSessionState,
  JsonAgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import { log, Logger } from './logger.js';
import type { ImagePreviewQuality } from './user-settings.js';

// Inline types not exported from the package
interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
}

/** Image attachment sent with prompt/steer/follow_up (pi ImageContent format) */
export interface RpcImage {
  type: 'image';
  /** base64-encoded image data (no data: URL prefix) */
  data: string;
  mimeType: string;
}

// ── Types ──

import { SandboxMount } from './pi-env.js';

export interface RpcClientOptions {
  /** Working directory for pi */
  cwd?: string;
  /** Per-session sandbox work roots (New Session modal / Sessions view) */
  workdirs?: string[];
  /** Provider to use */
  provider?: string;
  /** Model ID to use */
  model?: string;
  /** Additional CLI arguments */
  args?: string[];
  /** pi agent directory (PI_CODING_AGENT_DIR) — isolates config/sessions per user */
  agentDir?: string;
  /** Folders hidden from pi-file-monitor's bash-edit cards (pi-file-monitor env) */
  editIgnorePaths?: string[];
  /** Whether attached images are downscaled and shown to the chat model (pi-filetools env) */
  sendImagesToChatModel?: boolean;
  /** Preview quality preset name passed to pi-filetools */
  imagePreviewQuality?: ImagePreviewQuality | 'full';
  /** Non-streamed upstream requests for image-bearing chats (pi-images env) */
  imageStreamFix?: boolean;
  /** Run pi inside a docker container (this image name) instead of on the host.
   *  '' / undefined = disabled. Only the home volume + a tmpfs /tmp are
   *  visible; --network host keeps the model router reachable. */
  sandboxImage?: string;
  /** Planned sandbox mounts (pi-env.planSandboxMounts): pi env dir path-
   *  plus master-npm and the user's work area, at fixed container paths. */
  sandboxMounts?: SandboxMount[];
  /** Mount the host docker.sock into the sandbox (requires host access
   *  for the in-container user — granted per-user, admin-controlled). */
  sandboxDockerSocket?: boolean;
  /** Container cwd (-w); undefined = fallback /home/autere. */
  sandboxWorkingDir?: string;
}

export type RpcEventListener = (event: JsonAgentSessionEvent) => void;

interface PendingRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
}

// ── Strict JSONL reader ──

function attachJsonlLineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void
): () => void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  const emitLine = (line: string) => {
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  };

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) return;
      emitLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  };

  const onEnd = () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      emitLine(buffer);
      buffer = '';
    }
  };

  stream.on('data', onData);
  stream.on('end', onEnd);

  return () => {
    stream.off('data', onData);
    stream.off('end', onEnd);
  };
}

// ── RPC Client ──

export class MonitorRpcClient {
  private process: ChildProcess | null = null;
  private stopReadingStdout: (() => void) | null = null;
  private eventListeners: RpcEventListener[] = [];
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestId = 0;
  private stderr = '';
  private exitError: Error | null = null;
  private options: RpcClientOptions;
  /** Spawn opts (cwd/workdirs) — Sessions view reads them for editing. */
  getWorkdirs(): string[] { return [...(this.options.workdirs || [])]; }
  private _state: RpcSessionState | null = null;
  /** Logger bound to pi process PID — available after start() */
  private piLog: Logger | null = null;

  constructor(options: RpcClientOptions = {}) {
    this.options = options;
  }

  /** Whether the process is running */
  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  /**
   * Parse-check every .ts/.js extension file in the env's extensions dir and
   * rename the broken ones aside (<name>.broken-<ts>) so pi never sees them.
   * ponytail: catches parse errors only — runtime import failures inside a
   * broken extension still kill pi; a real fix needs pi-side lazy loading.
   */
  /**
   * Build the docker argv that runs pi inside the configured sandbox image.
   *
   * Mirrors the manually-verified setup:
   *   docker run --rm -i --network host --tmpfs /tmp \
   *     -v autere-home-$user:/home/autere \
   *     --entrypoint bash <image> -c 'env ... pi --mode rpc ...'
   *
   * - The home is a NAMED docker volume (not a bind path): the daemon resolves
   *   plain paths on the HOST, so a volume must be referenced by name.
   * - Mount at the identical /home/autere path: session files record host
   *   paths (/home/autere/...) as cwd — they must stay valid inside.
   * - --network host: the model router (9router) is on the host's localhost.
     */
  private buildSandboxCommand(piArgs: string[]): string[] {
    const image = this.options.sandboxImage!;
    const mounts = this.options.sandboxMounts;
    if (!mounts || mounts.length === 0) throw new Error('pi sandbox requested but no mounts were planned');

    // Bind mounts carry an absolute HOST source path in m.volume; named
    // volumes mount by name. Binds compose their host src from the source
    // path + subpath.
    const specs = mounts.map((m) => m.volume.startsWith('/')
      ? ['--mount', `type=bind,src=${m.subpath !== undefined && m.subpath !== '' ? `${m.volume}/${m.subpath}` : m.volume},dst=${m.dst}`]
      : m.subpath !== undefined && m.subpath !== ''
      ? ['--mount', `type=volume,src=${m.volume},dst=${m.dst},volume-subpath=${m.subpath}`]
      : ['-v', `${m.volume}:${m.dst}`]).flat();
    const cwd = this.options.sandboxWorkingDir || process.env.HOME || '/home/autere';
    // Escape-proofing: the sandbox NEVER runs as root (root in-container +
    // mounted docker.sock = host root via `docker run -v /:/host`). Force the
    // backend's own uid — it matches the volume ownership already; images
    // wanting a different non-root user are not supported (ponytail: add a
    // per-setting runAsUser if an image ever needs one). no-new-privileges
    // blocks setuid/sudo escape paths (sudo/setuid/file-caps all fail).
    const uid = process.getuid?.() ?? 1001;
    const gid = process.getgid?.() ?? uid;
    // docker.sock (per-user permission): a bind mount is a HOST path, not a
    // volume — plain --mount src. Socket perms are the daemon's (root:root
    // 660 typically); drop the sandbox's own GID for it.
    const sockGid = (() => {
      try { return statSync('/var/run/docker.sock').gid; } catch { return gid; }
    })();
    // No shell quoting in the inner script: env vars go through docker -e
    // (verbatim argv) and pi args travel as bash positional params.
    const out = [
      'docker', 'run',
      '-w', cwd,
      '--rm', '-i', '--init', '--network', 'host',
      '--user', `${uid}:${gid}`,
      // Supplementary GID of the socket: docker run only sets ONE --user
      // group; groups= lists EXTRA groups so mode 660 root:root sockets
      // are writable without making the whole container run as that group.
      ...(this.options.sandboxDockerSocket ? [
        ['--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock'],
        ['--group-add', String(sockGid)],
      ].flat() : []),
      '--security-opt', 'no-new-privileges',
      '--tmpfs', '/tmp:rw,size=512m',
      ...specs.map((s) => s.split(' ')).flat(),
      ...(this.options.agentDir ? [['-e', `PI_CODING_AGENT_DIR=${this.options.agentDir}`], ['-e', `PI_MEMORY_DIR=${join(this.options.agentDir, 'memory')}`]].flat() : []),
      ...(this.options.editIgnorePaths?.length ? [['-e', `EDIT_IGNORE_PATHS=${this.options.editIgnorePaths.join(':')}`]].flat() : []),
      ...(this.options.sendImagesToChatModel !== undefined ? [['-e', `IMAGE_SEND_PREVIEWS=${this.options.sendImagesToChatModel ? '1' : '0'}`]].flat() : []),
      ...(this.options.imagePreviewQuality && this.options.imagePreviewQuality !== 'full' ? [['-e', `IMAGE_PREVIEW_QUALITY=${JSON.stringify(this.options.imagePreviewQuality)}`]].flat() : []),
      ...(this.options.imageStreamFix !== undefined ? [['-e', `IMAGE_STREAM_FIX=${this.options.imageStreamFix ? '1' : '0'}`]].flat() : []),
      // pi tools may manage docker themselves — forward the socket if present
      '--entrypoint', 'bash',
      image,
      '-c', 'exec pi --mode rpc "$@"', '--',
      ...piArgs,
    ];
    return out;
  }

  private async quarantineBrokenExtensions(): Promise<void> {
    const dir = this.options.agentDir ? join(this.options.agentDir, 'extensions') : null;
    if (!dir || !existsSync(dir)) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (!name.endsWith('.ts') && !name.endsWith('.js')) continue;
      // Only direct files of the extensions dir; extension PACKAGES (dirs
      // with index.ts, e.g. pi-images) get their entry file checked too.
      const path = join(dir, name);
      const files: string[] = [];
      try {
        if (statSync(path).isFile()) files.push(path);
        else {
          const idx = join(path, 'index.ts');
          if (existsSync(idx)) files.push(idx);
          else {
            const idxJs = join(path, 'index.js');
            if (existsSync(idxJs)) files.push(idxJs);
          }
        }
      } catch { continue; }
      for (const file of files) {
        if (file.endsWith('.js')) continue; // plain JS parses npm-side; only TS needs transpilation
        try {
          // esbuild ships with tsx (a runtime-only dep here) — dynamic import keeps
          // this optional so prod images without tsx still run.
          const { transformSync } = await import('esbuild');
          transformSync(readFileSync(file, 'utf-8'), { loader: 'ts', sourcefile: file, format: 'esm' });
        } catch (err: any) {
          const broken = `${file}.broken-${Date.now()}`;
          try { renameSync(file, broken); } catch {}
          log.rpc.error(`Extension ${file} failed to parse — quarantined as ${broken}: ${err?.message || err}`);
        }
      }
    }
  }

  /** Whether the agent is streaming */
  get isStreaming(): boolean {
    return this._state?.isStreaming ?? false;
  }

  /**
   * Start the RPC agent process.
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Client already started');
    }
    this.exitError = null;

    this.quarantineBrokenExtensions().catch((e) => log.rpc.warn(`Extension parse check skipped: ${e}`));

    const args = ['--mode', 'rpc'];
    if (this.options.provider) {
      args.push('--provider', this.options.provider);
    }
    if (this.options.model) {
      args.push('--model', this.options.model);
    }
    if (this.options.args) {
      args.push(...this.options.args);
    }

    log.rpc.info('Starting pi RPC process:', args.join(' '));

    const piCommand = this.options.sandboxImage
      ? this.buildSandboxCommand(args)
      : null;
    const childProcess = spawn(
      piCommand ? piCommand[0] : 'pi',
      piCommand ? piCommand.slice(1) : args,
      {
        cwd: this.options.cwd,
      env: {
        ...process.env,
        ...(this.options.agentDir ? { PI_CODING_AGENT_DIR: this.options.agentDir } : {}),
        // pi-memory resolves its storage as $HOME/.pi/agent/memory (or
        // PI_MEMORY_DIR) and ignores PI_CODING_AGENT_DIR — without this every
        // user env would share the master agent's memory. Keep it per-user,
        // inside the env dir.
        ...(this.options.agentDir ? { PI_MEMORY_DIR: join(this.options.agentDir, 'memory') } : {}),
        // pi-file-monitor: folders hidden from bash-edit cards (colon-separated)
        ...(this.options.editIgnorePaths ? { EDIT_IGNORE_PATHS: this.options.editIgnorePaths.join(':') } : {}),
        // pi-filetools: attachment preview policy for the chat model
        ...(this.options.sendImagesToChatModel !== undefined ? { IMAGE_SEND_PREVIEWS: this.options.sendImagesToChatModel ? '1' : '0' } : {}),
        ...(this.options.imagePreviewQuality ? { IMAGE_PREVIEW_QUALITY: this.options.imagePreviewQuality === 'full' ? 'full' : JSON.stringify(this.options.imagePreviewQuality) } : {}),
        ...(this.options.imageStreamFix !== undefined ? { IMAGE_STREAM_FIX: this.options.imageStreamFix ? '1' : '0' } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // create a new process group so we can kill all children
    });

    this.process = childProcess;

    // Safety net: if parent dies unexpectedly, kill the child process group
    const parentExit = () => {
      if (childProcess.pid) {
        try { process.kill(-childProcess.pid, 'SIGKILL'); } catch {}
      }
    };
    process.on('exit', parentExit);
    childProcess.once('exit', () => {
      process.removeListener('exit', parentExit);
    });

    // Test-harness orphan record: pi lives in its own detached group, so a
    // SIGKILLed harness runner kills the backend but leaves pi reparented
    // to PID 1 forever. When running under the e2e/component harnesses,
    // append this pi to the run record so the NEXT run's reaper gets it.
    // Production spawns never set AUTERE_RUN_RECORD — zero prod cost.
    if (process.env.AUTERE_RUN_RECORD && childProcess.pid) {
      try {
        const recordFile = process.env.AUTERE_RUN_RECORD_FILE!;
        const rec = JSON.parse(readFileSync(recordFile, 'utf-8'));
        rec.pids = [...new Set([...(!rec.pids ? [] : rec.pids), childProcess.pid])];
        writeFileSync(recordFile, JSON.stringify(rec));
      } catch {}
    }

    // Create a PID-bound logger for pi's own output (stderr → err.log, stdout non-JSON → out.log)
    this.piLog = new Logger('pi', `pid=${childProcess.pid}`);

    // Route pi's stderr through autere's logger (→ err.log) with process identification
    childProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.stderr += text;
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line) this.piLog!.warn(`[pi-stderr] ${line}`);
      }
    });

    childProcess.once('exit', (code: number | null, signal: string | null) => {
      if (this.process !== childProcess) return;
      // Clear the handle: exitCode stays NULL on signal death, so isRunning
      // (process !== null && exitCode === null) would report a dead process
      // as running forever and getOrCreate would never respawn it.
      this.process = null;
      const error = this.createProcessExitError(code, signal);
      this.exitError = error;
      this.rejectPendingRequests(error);
    });

    childProcess.once('error', (error: Error) => {
      if (this.process !== childProcess) return;
      const processError = new Error(
        `Agent process error: ${error.message}. Stderr: ${this.stderr}`
      );
      this.exitError = processError;
      this.rejectPendingRequests(processError);
    });

    childProcess.stdin?.on('error', (error: Error) => {
      if (this.process !== childProcess) return;
      const stdinError =
        this.exitError ??
        new Error(
          `Agent process stdin error: ${error.message}. Stderr: ${this.stderr}`
        );
      this.exitError = stdinError;
      this.rejectPendingRequests(stdinError);
    });

    // Set up strict JSONL reader for stdout
    this.stopReadingStdout = attachJsonlLineReader(
      childProcess.stdout!,
      (line) => {
        this.handleLine(line);
      }
    );

    // Wait for process to initialize
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The 'exit' handler clears this.process — a fast-failing spawn (docker
    // socket missing) would make this read `null.exitCode`. Treat null as
    // "already dead" and fail with the recorded exit error.
    if (this.process === null || this.process.exitCode !== null) {
      throw this.exitError ?? new Error('Agent process exited immediately after spawn');
    }

    log.rpc.info(`pi RPC process started (pid=${childProcess.pid})`);
  }

  /**
   * Stop the RPC agent process.
   */
  async stop(): Promise<void> {
    if (!this.process) return;
    this.stopReadingStdout?.();
    this.stopReadingStdout = null;
    const pid = this.process.pid;
    if (pid) {
      // Kill the entire process group (negative PID = group kill)
      try { process.kill(-pid, 'SIGTERM'); } catch {}
    } else {
      this.process.kill('SIGTERM');
    }

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (pid) {
          try { process.kill(-pid, 'SIGKILL'); } catch {}
        } else {
          this.process?.kill('SIGKILL');
        }
        resolve(undefined);
      }, 2000);
      this.process?.on('exit', () => {
        clearTimeout(timeout);
        resolve(undefined);
      });
    });

    this.process = null;
    this.rejectPendingRequests(new Error('Client stopped'));
    this.pendingRequests.clear();
  }

  /**
   * Subscribe to agent events.
   */
  onEvent(listener: RpcEventListener): () => void {
    this.eventListeners.push(listener);
    return () => {
      const index = this.eventListeners.indexOf(listener);
      if (index !== -1) this.eventListeners.splice(index, 1);
    };
  }

  // ── Commands ──

  async prompt(message: string, images?: RpcImage[]): Promise<void> {
    log.rpc.debug(`RPC: prompt("${message.slice(0, 80)}${message.length > 80 ? '…' : ''}")${images?.length ? ` +${images.length} image(s)` : ''}`);
    const res = await this.send({ type: 'prompt', message, ...(images?.length ? { images } : {}) });
    // pi answers pre-turn failures (auth, upstream provider errors…) with a
    // success:false response — never an event — so reject or callers (one-shot
    // persona generation) would silently wait out their timeout.
    if (!res.success) throw new Error((res as any).error || 'prompt failed');
  }

  async steer(message: string, images?: RpcImage[]): Promise<void> {
    log.rpc.debug(`RPC: steer("${message.slice(0, 80)}${message.length > 80 ? '…' : ''}")${images?.length ? ` +${images.length} image(s)` : ''}`);
    await this.send({ type: 'steer', message, ...(images?.length ? { images } : {}) });
  }

  async followUp(message: string, images?: RpcImage[]): Promise<void> {
    log.rpc.debug(`RPC: follow_up("${message.slice(0, 80)}${message.length > 80 ? '…' : ''}")${images?.length ? ` +${images.length} image(s)` : ''}`);
    await this.send({ type: 'follow_up', message, ...(images?.length ? { images } : {}) });
  }

  /** Clear all queued steer/follow-up messages; pi returns what it dropped. */
  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    // ponytail: 0.84.2 typings lack clear_queue (runtime pi is 0.84.4); drop the cast when the dep bumps
    const response = await this.send({ type: 'clear_queue' } as never);
    const data = this.getData(response) as { steering?: string[]; followUp?: string[] };
    return { steering: data.steering ?? [], followUp: data.followUp ?? [] };
  }

  async abort(): Promise<void> {
    await this.send({ type: 'abort' });
  }

  async newSession(): Promise<{ cancelled: boolean }> {
    const response = await this.send({ type: 'new_session' });
    return this.getData(response) as { cancelled: boolean };
  }

  async getState(): Promise<RpcSessionState> {
    const response = await this.send({ type: 'get_state' });
    const state = this.getData(response) as RpcSessionState;
    this._state = state;
    return state;
  }

  async setModel(provider: string, modelId: string): Promise<ModelInfo> {
    const response = await this.send({ type: 'set_model', provider, modelId });
    return this.getData(response) as ModelInfo;
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    const response = await this.send({ type: 'get_available_models' });
    const data = this.getData(response) as { models: ModelInfo[] };
    return data.models;
  }

  async compact(): Promise<any> {
    // Compaction can take minutes on large contexts — no arbitrary timeout;
    // pi's RPC response (or an error response) settles this.
    const response = await this.send({ type: 'compact' }, 0);
    return this.getData(response);
  }

  async setSessionName(name: string): Promise<void> {
    await this.send({ type: 'set_session_name', name });
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    const response = await this.send({ type: 'switch_session', sessionPath });
    return this.getData(response) as { cancelled: boolean };
  }

  async getSessionStats(): Promise<any> {
    const response = await this.send({ type: 'get_session_stats' });
    return this.getData(response);
  }

  async getMessages(): Promise<any[]> {
    const response = await this.send({ type: 'get_messages' });
    const data = this.getData(response) as { messages: any[] };
    return data.messages;
  }

  // ── Internal ──

  private handleLine(line: string): void {
    try {
      const data = JSON.parse(line);

      // Update cached state from events
      if (data.type === 'agent_start') {
        if (this._state) this._state.isStreaming = true;
      } else if (data.type === 'agent_end' || data.type === 'agent_settled') {
        if (this._state) this._state.isStreaming = false;
      } else if (data.type === 'model_select' && data.model) {
        if (this._state) {
          this._state.model = data.model;
        }
      }

      // Check if it's a response to a pending request
      if (data.type === 'response' && data.id && this.pendingRequests.has(data.id)) {
        const pending = this.pendingRequests.get(data.id)!;
        this.pendingRequests.delete(data.id);
        if (!data.success) {
          log.rpc.error(`RPC response error: ${data.command} failed: ${data.error}`);
        }
        pending.resolve(data);
        return;
      }

      // Otherwise it's an event
      for (const listener of this.eventListeners) {
        try {
          listener(data);
        } catch (err) {
          log.rpc.error('Event listener error:', err);
        }
      }
    } catch {
      // Non-JSON output from pi (debug prints, extension logs, etc.) — route to out.log
      this.piLog?.debug(`[pi-stdout] ${line}`);
    }
  }

  private createProcessExitError(code: number | null, signal: string | null): Error {
    // Docker-unreachable is the common sandbox spawn failure — name it.
    if (/docker.sock|docker daemon|docker API/i.test(this.stderr)) {
      return new Error(`docker socket not available — the docker daemon is unreachable from the backend (cannot start sandboxed session). Stderr: ${this.stderr}`);
    }
    return new Error(
      `Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`
    );
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private send(command: RpcCommand, timeoutMs = 30000): Promise<RpcResponse> {
    const childProcess = this.process;
    const stdin = childProcess?.stdin;
    if (!childProcess || !stdin) {
      return Promise.reject(new Error('Client not started'));
    }
    if (this.exitError) {
      return Promise.reject(this.exitError);
    }
    if (childProcess.exitCode !== null) {
      const error = this.createProcessExitError(
        childProcess.exitCode,
        childProcess.signalCode
      );
      this.exitError = error;
      return Promise.reject(error);
    }
    if (stdin.destroyed || !stdin.writable) {
      const error = new Error(
        `Agent process stdin is not writable. Stderr: ${this.stderr}`
      );
      this.exitError = error;
      return Promise.reject(error);
    }

    const id = `req_${++this.requestId}`;
    const fullCommand = { ...command, id };

    return new Promise((resolve, reject) => {
      // Commands that can legitimately take a long time (e.g. compaction) are
      // given no timeout (timeoutMs <= 0) — the RPC response, a genuine RPC
      // error response, or process death via rejectPendingRequests will settle
      // the promise.
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
            this.pendingRequests.delete(id);
            reject(
              new Error(
                `Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`
              )
            );
          }, timeoutMs)
        : null;

      this.pendingRequests.set(id, {
        resolve: (response) => {
          if (timeout) clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          if (timeout) clearTimeout(timeout);
          reject(error);
        },
      });

      try {
        stdin.write(JSON.stringify(fullCommand) + '\n');
      } catch (error) {
        const writeError =
          error instanceof Error ? error : new Error(String(error));
        const pending = this.pendingRequests.get(id);
        this.pendingRequests.delete(id);
        pending?.reject(writeError);
      }
    });
  }

  private getData(response: RpcResponse): any {
    if (!response.success) {
      throw new Error((response as any).error || 'Command failed');
    }
    return (response as any).data;
  }
}
