/**
 * RPC Client wrapper for autere.
 *
 * Uses the RpcClient from @earendil-works/pi-coding-agent to spawn pi
 * in RPC mode and communicate via JSON lines on stdin/stdout.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { statSync, existsSync } from 'node:fs';
import type {
  RpcCommand,
  RpcResponse,
  RpcSessionState,
  JsonAgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import { log } from './logger.js';

// Inline types not exported from the package
interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
}

interface RpcSlashCommand {
  name: string;
  description?: string;
  source: string;
  sourceInfo?: any;
}

// ── Types ──

export interface RpcClientOptions {
  /** Working directory for pi */
  cwd?: string;
  /** Provider to use */
  provider?: string;
  /** Model ID to use */
  model?: string;
  /** Additional CLI arguments */
  args?: string[];
  /** pi agent directory (PI_CODING_AGENT_DIR) — isolates config/sessions per user */
  agentDir?: string;
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
  private _state: RpcSessionState | null = null;
  private _availableModels: ModelInfo[] = [];

  constructor(options: RpcClientOptions = {}) {
    this.options = options;
  }

  /** Current cached session state */
  get state(): RpcSessionState | null {
    return this._state;
  }

  /** Current cached available models */
  get availableModels(): ModelInfo[] {
    return this._availableModels;
  }

  /** Whether the process is running */
  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  /** Whether the agent is streaming */
  get isStreaming(): boolean {
    return this._state?.isStreaming ?? false;
  }

  /** Get collected stderr output */
  getStderr(): string {
    return this.stderr;
  }

  /**
   * Start the RPC agent process.
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Client already started');
    }
    this.exitError = null;

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

    const childProcess = spawn('pi', args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...(this.options.agentDir ? { PI_CODING_AGENT_DIR: this.options.agentDir } : {}),
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

    // Collect stderr for debugging
    childProcess.stderr?.on('data', (data: Buffer) => {
      this.stderr += data.toString();
      process.stderr.write(data);
    });

    childProcess.once('exit', (code: number | null, signal: string | null) => {
      if (this.process !== childProcess) return;
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

    if (this.process.exitCode !== null) {
      const error =
        this.exitError ??
        this.createProcessExitError(
          this.process.exitCode,
          this.process.signalCode
        );
      this.exitError = error;
      throw error;
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

  async prompt(message: string): Promise<void> {
    log.rpc.debug(`RPC: prompt("${message.slice(0, 80)}${message.length > 80 ? '…' : ''}")`);
    await this.send({ type: 'prompt', message });
  }

  async steer(message: string): Promise<void> {
    log.rpc.debug(`RPC: steer("${message.slice(0, 80)}${message.length > 80 ? '…' : ''}")`);
    await this.send({ type: 'steer', message });
  }

  async followUp(message: string): Promise<void> {
    log.rpc.debug(`RPC: follow_up("${message.slice(0, 80)}${message.length > 80 ? '…' : ''}")`);
    await this.send({ type: 'follow_up', message });
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

  async cycleModel(): Promise<{ model: ModelInfo; thinkingLevel: string; isScoped: boolean } | null> {
    const response = await this.send({ type: 'cycle_model' });
    return this.getData(response) as { model: ModelInfo; thinkingLevel: string; isScoped: boolean } | null;
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    const response = await this.send({ type: 'get_available_models' });
    const data = this.getData(response) as { models: ModelInfo[] };
    this._availableModels = data.models;
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

  async getEntries(since?: string): Promise<{ entries: any[]; leafId: string | null }> {
    const response = await this.send({ type: 'get_entries', since });
    return this.getData(response) as { entries: any[]; leafId: string | null };
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const response = await this.send({ type: 'export_html', outputPath });
    return this.getData(response) as { path: string };
  }

  async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    const response = await this.send({ type: 'fork', entryId });
    return this.getData(response) as { text: string; cancelled: boolean };
  }

  async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
    const response = await this.send({ type: 'get_fork_messages' });
    const data = this.getData(response) as { messages: Array<{ entryId: string; text: string }> };
    return data.messages;
  }

  async getCommands(): Promise<RpcSlashCommand[]> {
    const response = await this.send({ type: 'get_commands' });
    const data = this.getData(response) as { commands: RpcSlashCommand[] };
    return data.commands;
  }

  /**
   * Wait for agent to become idle.
   */
  waitForIdle(timeout = 60000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
      }, timeout);

      const unsubscribe = this.onEvent((event: any) => {
        if (event.type === 'agent_settled') {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
    });
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
      // Ignore non-JSON lines
    }
  }

  private createProcessExitError(code: number | null, signal: string | null): Error {
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
