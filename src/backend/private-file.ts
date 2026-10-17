import { mkdirSync, chmodSync, renameSync, writeFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

/** Atomically replace a private state file without relying on the process umask. */
export function writePrivateFile(file: string, data: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = join(dir, `.private-tmp-${randomUUID()}`);
  writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, file);
  } catch (error) {
    try { rmSync(tmp); } catch {}
    throw error;
  }
}
