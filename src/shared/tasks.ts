/**
 * Scheduled-task types, shared by the backend scheduler, the frontend
 * settings card and the CLI (single source of truth — was duplicated in
 * src/backend/scheduler.ts and src/frontend/types/index.ts).
 */

import { validateCron } from './cron.js';

export interface ScheduledTask {
  id: string;
  name: string;
  /** 5-field cron expression (minute hour dom month dow) */
  schedule: string;
  /** Prompt sent to the pi agent */
  prompt: string;
  /** Optional model override for this task's runs (falls back to the
   *  scheduler's default / the user's pi default model when unset) */
  model?: string;
  /** Optional shell script whose stdout is seeded into the prompt */
  seedScript?: string;
  /** Optional shell script run against the final assistant message (stdin) */
  resultScript?: string;
  /** Keep each run's pi session after the run ends. Unset/false (the
   *  default): the run's session file is deleted for good once the run
   *  completes — the run record under scheduled-task-logs/ stays. */
  saveSession?: boolean;
  /** One-off task: at most one run ever — the run disables the task, and
   *  both a scheduled tick and a manual trigger are refused afterwards. */
  once?: boolean;
  /** Run every time on the SAME pi session: the run's session file is kept
   *  and switched into at the next spawn (implies the session survives
   *  runs, like saveSession). */
  reuseSession?: boolean;
  /** With reuseSession: wipe the reused session's context before each run —
   *  session id and name stay, prior messages do not. */
  clearSession?: boolean;
  /** Keep only the MOST RECENT run's session: when a run starts, the
   *  previous run's saved session is deleted; the running one is kept until
   *  the next run replaces it. Mutually exclusive with saveSession and
   *  reuseSession. */
  saveLastSession?: boolean;
  /** Scheduler-internal: session file backing reuseSession (written after a
   *  run; never accepted from clients). */
  reusedSessionFile?: string;
  /** Scheduler-internal: session file saved by the last run under
   *  saveLastSession (never accepted from clients). */
  savedSessionFile?: string;
  /** Spawn environment inherited from the session that created the task:
   *  run sessions spawn in this cwd and sandbox work area. Resolved by the
   *  backend from the creating session (never trusted from the client). */
  cwd?: string;
  workdirs?: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Validate a task create/update payload. Pure and shared so the frontend
 *  tests exercise the real rules. Path-level workdirs validation (allowed
 *  roots, existence) lives in the backend routes — this is shape + policy. */
export function canRunTaskScripts(role: string | null | undefined): boolean {
  return role === 'admin';
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
    if (typeof input[key] === 'string' && input[key].length > 32_768) return `${key} must be at most 32768 characters`;
  }
  if (typeof input.enabled !== 'undefined' && typeof input.enabled !== 'boolean') {
    return 'enabled must be a boolean';
  }
  for (const key of ['saveSession', 'once', 'reuseSession', 'clearSession', 'saveLastSession'] as const) {
    if (typeof input[key] !== 'undefined' && typeof input[key] !== 'boolean') {
      return `${key} must be a boolean`;
    }
  }
  if (Array.isArray(input.workdirs)) {
    for (const wd of input.workdirs) {
      if (typeof wd !== 'string' || !wd.trim()) return 'workdirs must be non-empty path strings';
    }
  } else if (typeof input.workdirs !== 'undefined' && input.workdirs !== null) {
    return 'workdirs must be an array of paths';
  }
  if (input.saveLastSession === true && input.saveSession === true) {
    return 'saveLastSession cannot be combined with saveSession';
  }
  if (input.saveLastSession === true && input.reuseSession === true) {
    return 'saveLastSession cannot be combined with reuseSession';
  }
  if (input.clearSession === true && input.reuseSession !== true) {
    return 'clearSession requires reuseSession';
  }
  return null;
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
