/**
 * Scheduled task execution.
 *
 * Scheduled tasks are stored per user as JSON files under
 * ~/.autere/users/{user}/scheduled-tasks/{taskId}.json and execution
 * logs under ~/.autere/users/{user}/scheduled-task-logs/{taskId}/{runId}.json.
 *
 * The Scheduler evaluates each enabled task's cron schedule on a tick and
 * starts runs. Runs are fully independent: each spawns a DEDICATED pi RPC
 * process (per-user pi env), sends the prompt (optionally seeded by the
 * seed script's stdout), waits for the agent to finish, optionally runs
 * the result script against the final assistant message (stdin), then
 * stops the pi process. Multiple runs execute concurrently; a single task
 * never overlaps with itself.
 *
 * Tasks are re-read from disk on every tick, so the scheduler survives
 * backend restarts without extra persistence — schedules are re-evaluated
 * from the JSON files after a restart (missed ticks while down are not
 * replayed).
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { USER_SETTINGS_DIR } from './constants.js';
import { ensurePiEnv } from './pi-env.js';
import { MonitorRpcClient } from './rpc-client.js';
import { cronMatches, validateCron } from '../shared/cron.js';
import { sanitizeUserName } from '../shared/format.js';
import { log } from './logger.js';
import { autoSessionName } from './utils.js';
import { getUserSetting } from './user-settings.js';
import { sendNotification } from './notifications.js';

import type {
  ScheduledTask,
  TaskRunStatus,
  TaskRunRecord,
  TaskRunLog,
} from '../shared/tasks.js';

export type { ScheduledTask, TaskRunStatus, TaskRunRecord, TaskRunLog };

export interface SchedulerOptions {
  model?: string;
  args?: string[];
  /** Tick interval in ms (default 20s) */
  tickMs?: number;
  /** Max duration of one agent run in ms (default 15 min) */
  runTimeoutMs?: number;
}

// ── Paths ──

function isSafeId(id: string): boolean {
  return /^[\w-]+$/.test(id);
}

export function userTasksDir(user: string): string {
  return join(USER_SETTINGS_DIR, sanitizeUserName(user), 'scheduled-tasks');
}

export function userRunsDir(user: string): string {
  return join(USER_SETTINGS_DIR, sanitizeUserName(user), 'scheduled-task-logs');
}

function taskFile(user: string, taskId: string): string {
  return join(userTasksDir(user), `${taskId}.json`);
}

function runFile(user: string, taskId: string, runId: string): string {
  return join(userRunsDir(user), taskId, `${runId}.json`);
}

// ── Task store (per-user JSON files) ──

export function listTasks(user: string): ScheduledTask[] {
  const dir = userTasksDir(user);
  const tasks: ScheduledTask[] = [];
  try {
    if (!existsSync(dir)) return tasks;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        tasks.push(JSON.parse(readFileSync(join(dir, name), 'utf-8')));
      } catch (err) {
        log.scheduler.error(`Failed to read task file ${name}:`, err);
      }
    }
  } catch (err) {
    log.scheduler.error(`Failed to list tasks for "${user}":`, err);
  }
  return tasks.sort((a, b) => a.createdAt - b.createdAt);
}

export function getTask(user: string, taskId: string): ScheduledTask | null {
  if (!isSafeId(taskId)) return null;
  try {
    const f = taskFile(user, taskId);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf-8'));
  } catch (err) {
    log.scheduler.error(`Failed to read task ${taskId}:`, err);
    return null;
  }
}

export function saveTask(user: string, task: ScheduledTask): void {
  const f = taskFile(user, task.id);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = join(dirname(f), `.${task.id}.tmp-${randomUUID()}`);
  writeFileSync(tmp, JSON.stringify(task, null, 2), 'utf-8');
  renameSync(tmp, f);
}

export function deleteTask(user: string, taskId: string): boolean {
  if (!isSafeId(taskId)) return false;
  const f = taskFile(user, taskId);
  if (!existsSync(f)) return false;
  try {
    rmSync(f);
  } catch (err) {
    log.scheduler.error(`Failed to delete task file ${taskId}:`, err);
    return false;
  }
  // Best effort: remove run logs too
  try { rmSync(join(userRunsDir(user), taskId), { recursive: true, force: true }); }
  catch (err) {
    log.scheduler.error(`Failed to remove run logs for task ${taskId}:`, err);
  }
  return true;
}

export function validateTaskInput(input: any): string | null {
  if (!input || typeof input !== 'object') return 'Task must be an object';
  if (typeof input.name !== 'string' || !input.name.trim()) return 'name is required';
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return 'prompt is required';
  if (typeof input.schedule !== 'string' || !input.schedule.trim()) return 'schedule is required';
  const cronErr = validateCron(input.schedule);
  if (cronErr) return `Invalid schedule: ${cronErr}`;
  if (input.model !== undefined && input.model !== null && input.model !== '' && typeof input.model !== 'string') {
    return 'model must be a string';
  }
  for (const key of ['seedScript', 'resultScript'] as const) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== '' && typeof input[key] !== 'string') {
      return `${key} must be a string`;
    }
  }
  if (typeof input.enabled !== 'undefined' && typeof input.enabled !== 'boolean') {
    return 'enabled must be a boolean';
  }
  return null;
}

// ── Run records ──

/** List run records for a user (optionally for one task), newest first */
export function listRuns(user: string, taskId?: string, limit = 100): TaskRunRecord[] {
  const base = userRunsDir(user);
  const out: TaskRunRecord[] = [];
  try {
    if (!existsSync(base)) return out;
    const taskDirs = taskId ? [taskId] : readdirSync(base);
    for (const t of taskDirs) {
      if (!isSafeId(t)) continue;
      const dir = join(base, t);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          out.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')));
        } catch (err) {
          log.scheduler.error(`Failed to read run file ${t}/${f}:`, err);
        }
      }
    }
  } catch (err) {
    log.scheduler.error(`Failed to list runs for "${user}":`, err);
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out.slice(0, limit);
}

/** Read a full run log (with prompt/result details) */
export function readRunLog(user: string, taskId: string, runId: string): TaskRunLog | null {
  if (!isSafeId(taskId) || !isSafeId(runId)) return null;
  try {
    const f = runFile(user, taskId, runId);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf-8'));
  } catch (err) {
    log.scheduler.error(`Failed to read run log ${taskId}/${runId}:`, err);
    return null;
  }
}

// ── Shell script helper ──

interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
  failed: boolean;
}

/** Run a shell script via /bin/bash. stdinData (when not null) is written to the script's stdin. */
function runShellScript(script: string, stdinData: string | null, timeoutMs: number): Promise<ScriptResult> {
  return new Promise((resolve) => {
    if (stdinData === null) {
      execFile('/bin/bash', ['-c', script], {
        encoding: 'utf-8',
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        resolve({
          code: err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0,
          stdout: stdout || '',
          stderr: stderr || '',
          failed: !!err,
        });
      });
      return;
    }
    const child = spawn('/bin/bash', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let settled = false;
    const done = (r: ScriptResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      done({ code: 124, stdout, stderr: stderr || 'Script timed out', failed: true });
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e: Error) => done({ code: 1, stdout, stderr: stderr + String(e), failed: true }));
    child.on('close', (code: number | null) => done({ code: code ?? 1, stdout, stderr, failed: code !== 0 }));
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdinData);
  });
}

// ── Scheduler ──

interface ActiveRun {
  user: string;
  taskId: string;
  runId: string;
  rpc: MonitorRpcClient;
  abort: () => void;
}

export class Scheduler {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private activeRuns = new Map<string, ActiveRun>(); // key: user/taskId
  /** Task id → minute keys already fired this process lifetime */
  private firedMinutes = new Map<string, Set<string>>();
  private readonly tickMs: number;
  private readonly runTimeoutMs: number;
  private readonly spawnOptions: { model?: string; args?: string[] };

  constructor(options: SchedulerOptions = {}) {
    this.tickMs = options.tickMs ?? 20_000;
    this.runTimeoutMs = options.runTimeoutMs ?? 15 * 60 * 1000;
    this.spawnOptions = { model: options.model, args: options.args };
  }

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      try { this.tick(); } catch (err) {
        log.scheduler.error('Scheduler tick failed:', err);
      }
    }, this.tickMs);
    log.scheduler.info(`Scheduler started (tick=${this.tickMs}ms)`);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const run of [...this.activeRuns.values()]) {
      try { run.abort(); } catch (err) {
        log.scheduler.error('Failed to abort active run:', err);
      }
    }
  }

  /** Users that have scheduled tasks (a scheduled-tasks dir on disk) */
  private usersWithTasks(): string[] {
    try {
      if (!existsSync(USER_SETTINGS_DIR)) return [];
      return readdirSync(USER_SETTINGS_DIR)
        .filter(name => existsSync(join(USER_SETTINGS_DIR, name, 'scheduled-tasks')));
    } catch (err) {
      log.scheduler.error('Failed to list users for scheduling:', err);
      return [];
    }
  }

  private tick(): void {
    const now = new Date();
    const minuteKey = [
      now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(),
    ].join('-');
    for (const user of this.usersWithTasks()) {
      for (const task of listTasks(user)) {
        if (!task.enabled) continue;
        let fired = this.firedMinutes.get(task.id);
        if (!fired) { fired = new Set(); this.firedMinutes.set(task.id, fired); }
        if (fired.has(minuteKey)) continue;
        if (!cronMatches(task.schedule, now)) continue;
        fired.add(minuteKey);
        // Prune old minute keys so the map doesn't grow forever
        if (fired.size > 120) this.firedMinutes.set(task.id, new Set([minuteKey]));
        log.scheduler.info(`Task "${task.name}" (${task.id}) due — starting run`);
        this.startRun(user, task, 'schedule').catch(err => {
          log.scheduler.error(`Scheduled run of task "${task.name}" failed to start:`, err);
        });
      }
    }
  }

  /** Whether a task currently has a run in flight */
  isRunning(user: string, taskId: string): boolean {
    return this.activeRuns.has(`${user}/${taskId}`);
  }

  /**
   * Trigger a task run immediately (manual / "run now", also used by tests).
   * Resolves with the runId once the run has started, or rejects when the
   * task is already running. The run proceeds in the background; its
   * progress and logs are observed via listRuns()/readRunLog().
   */
  async runNow(user: string, taskId: string): Promise<string> {
    const task = getTask(user, taskId);
    if (!task) throw new Error('Task not found');
    return this.startRun(user, task, 'manual');
  }

  private async startRun(user: string, task: ScheduledTask, trigger: 'schedule' | 'manual'): Promise<string> {
    const key = `${user}/${task.id}`;
    if (this.activeRuns.has(key)) {
      throw new Error('Task is already running');
    }

    const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const record: TaskRunLog = {
      runId,
      taskId: task.id,
      taskName: task.name,
      trigger,
      startedAt: Date.now(),
      status: 'running',
      prompt: task.prompt,
      log: [],
    };
    const addLog = (line: string) => {
      // Epoch ms + message — NO backend time formatting; the frontend
      // renders `t` in the user's locale and timezone.
      record.log.push({ t: Date.now(), line });
    };
    const writeRecord = () => {
      try {
        const f = runFile(user, task.id, runId);
        mkdirSync(dirname(f), { recursive: true });
        const tmp = join(dirname(f), `.${runId}.tmp-${randomUUID()}`);
        writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
        renameSync(tmp, f);
      } catch (err) {
        log.scheduler.error(`Failed to write run record ${runId}:`, err);
      }
    };
    addLog(`Run started (trigger: ${trigger})`);
    writeRecord();

    let aborted = false;
    let abortWaiter: (() => void) | null = null;
    const rpc = new MonitorRpcClient({
      // Per-task model override wins over the scheduler default; when unset
      // the user's pi default model applies.
      model: task.model || this.spawnOptions.model,
      args: this.spawnOptions.args,
      agentDir: ensurePiEnv(user),
    });
    const active: ActiveRun = {
      user,
      taskId: task.id,
      runId,
      rpc,
      abort: () => {
        aborted = true;
        abortWaiter?.();
        rpc.stop().catch(() => {});
      },
    };
    this.activeRuns.set(key, active);

    // The run proceeds in the background — the caller gets the runId back
    // immediately and polls the run record for status/log.
    const runPromise = (async () => {
      try {
        // 1. Start a dedicated pi agent for this run
        addLog('Starting pi agent for scheduled run');
        await rpc.start();
        if (aborted) throw new Error('Run aborted');

        // Auto-name task-run sessions: "[task] - <user locale + timezone date+time>".
        // Uses the user's persisted locale/IANA timezone so the name matches
        // what the user sees in the UI (Intl does the zone conversion).
        let runName = '';
        try {
          const locale = getUserSetting(user, 'locale', '');
          const timeZone = getUserSetting(user, 'timeZone', '');
          runName = autoSessionName('[task]', {
            locale: typeof locale === 'string' && locale ? locale : undefined,
            timeZone: typeof timeZone === 'string' && timeZone ? timeZone : undefined,
          });
          await rpc.setSessionName(runName);
        } catch (err) {
          log.scheduler.error(`Failed to auto-name run session ${runId}:`, err);
        }

        // Task-start notification (Settings → Notifications): the run's
        // session exists now, so the notification can name and open it.
        try {
          const state = await rpc.getState();
          await sendNotification(user, 'taskStart', {
            title: runName || state.sessionName || task.name,
            body: `Scheduled task "${task.name}" started`,
            path: state.sessionId ? `session/${state.sessionId}` : null,
          });
        } catch (err) {
          log.scheduler.error(`Task-start notification for "${task.name}" failed:`, err);
        }

        // 2. Seed data into the prompt (optional script)
        let prompt = task.prompt;
        if (task.seedScript?.trim()) {
          addLog('Running seed script');
          const seeded = await runShellScript(task.seedScript, null, 60_000);
          record.seedOutput = seeded.stdout;
          if (seeded.failed) {
            addLog(`Seed script failed (code ${seeded.code}): ${seeded.stderr.slice(0, 500)}`);
          } else {
            addLog(`Seed script produced ${seeded.stdout.length} chars`);
          }
          if (seeded.stdout.trim()) {
            prompt = prompt.trim()
              ? `${prompt.trim()}\n\nData:\n${seeded.stdout.trim()}`
              : seeded.stdout.trim();
          }
        }
        if (!prompt.trim()) {
          throw new Error('Prompt is empty (no prompt and no seed script output)');
        }
        record.prompt = prompt;

        // 3. Send the prompt and wait for the agent's final assistant message
        const agentResultP = this.waitForAgentResult(rpc, (hook) => { abortWaiter = hook; });
        addLog(`Sending prompt (${prompt.length} chars)`);
        await rpc.prompt(prompt);
        addLog('Prompt sent — waiting for agent to finish');
        const agentResult = await agentResultP;
        if (agentResult.startsWith('__AGENT_ERROR__:')) {
          throw new Error(agentResult.slice('__AGENT_ERROR__:'.length));
        }
        record.agentResult = agentResult;
        addLog(`Agent finished (${agentResult.length} chars)`);

        // 4. Run the result script against the agent output (optional)
        if (task.resultScript?.trim()) {
          addLog('Running result script');
          const res = await runShellScript(task.resultScript, agentResult, 120_000);
          record.resultScriptOutput = res.stdout;
          if (res.failed) {
            addLog(`Result script failed (code ${res.code}): ${res.stderr.slice(0, 500)}`);
          } else {
            addLog(`Result script produced ${res.stdout.length} chars`);
          }
        }

        record.status = 'success';
        addLog('Run completed successfully');
      } catch (err: any) {
        record.status = 'error';
        record.error = err?.message || String(err);
        addLog(`Run failed: ${record.error}`);
        log.scheduler.error(`Run ${runId} of task "${task.name}" failed:`, err);
      } finally {
        // 5. Always stop the pi agent started for this run
        try { await rpc.stop(); } catch {}
        addLog('pi agent stopped');
        record.finishedAt = Date.now();
        writeRecord();
        this.activeRuns.delete(key);
      }
    })();
    runPromise.catch(err => log.scheduler.error('Unhandled run error:', err));

    return runId;
  }

  /**
   * Resolves with the final assistant text of the next agent turn on the
   * given RPC client. Agent errors resolve as "__AGENT_ERROR__:<message>".
   */
  private waitForAgentResult(
    rpc: MonitorRpcClient,
    registerAbort: (fn: () => void) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let off: () => void = () => {};
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        off();
        fn();
      };
      const timeout = setTimeout(() => {
        finish(() => reject(new Error(`Agent run timed out after ${this.runTimeoutMs}ms`)));
      }, this.runTimeoutMs);
      off = rpc.onEvent((event: any) => {
        if (event.type !== 'message_end' || event.message?.role !== 'assistant') return;
        const text = (event.message.content || [])
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('');
        if (event.message.stopReason === 'error' || event.message.errorMessage) {
          finish(() => resolve(`__AGENT_ERROR__:${event.message.errorMessage || 'Agent returned an error'}`));
          return;
        }
        if (text) {
          finish(() => resolve(text));
        }
      });
      registerAbort(() => {
        finish(() => reject(new Error('Run aborted')));
      });
    });
  }
}
