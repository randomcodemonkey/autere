/**
 * Scheduled-task types, shared by the backend scheduler, the frontend
 * settings card and the CLI (single source of truth — was duplicated in
 * src/backend/scheduler.ts and src/frontend/types/index.ts).
 */

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
