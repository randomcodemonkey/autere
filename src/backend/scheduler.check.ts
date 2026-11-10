/** A scheduled run is failed for going silent, never for being slow: a run that
 *  keeps emitting pi events (polling loop, long tool) must outlive the budget. */
import assert from 'node:assert';
import { Scheduler } from './scheduler.js';

const IDLE_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeRpc() {
  const listeners: any[] = [];
  const exitListeners: any[] = [];
  return {
    rpc: {
      onEvent: (h: any) => { listeners.push(h); return () => {}; },
      onProcessExit: (h: any) => { exitListeners.push(h); return () => {}; },
    } as any,
    emit: (event: any) => listeners.forEach((h) => h(event)),
    exit: (err: Error) => exitListeners.forEach((h) => h(err)),
  };
}

const scheduler = new Scheduler({ runTimeoutMs: IDLE_MS });
const wait = (rpc: any) => (scheduler as any).waitForAgentResult(rpc, () => {});

// --- a run that keeps working outlives the budget ---------------------------
{
  const f = fakeRpc();
  const done = wait(f.rpc);
  f.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } });
  for (let i = 0; i < 6; i++) {
    await sleep(IDLE_MS / 3);
    f.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } });
  }
  f.emit({ type: 'agent_settled' });
  assert.equal(await done, 'working', 'a run that keeps emitting events was timed out');
}

// --- silence fails the run -------------------------------------------------
{
  const f = fakeRpc();
  const started = Date.now();
  await assert.rejects(wait(f.rpc), /no activity for 150ms/, 'a silent run did not time out');
  assert.ok(Date.now() - started >= IDLE_MS, 'timed out before the budget elapsed');
}

// --- the budget restarts on the last event, not on the run start ------------
{
  const f = fakeRpc();
  const started = Date.now();
  const done = wait(f.rpc);
  done.catch(() => {}); // the timer may fire before the emit below races it
  await sleep(IDLE_MS * 0.6);
  f.emit({ type: 'tool_execution_start', toolName: 'bash' });
  await assert.rejects(done, /no activity/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= IDLE_MS * 1.5, `timeout ignored the event mid-run (fired after ${elapsed}ms)`);
}

// --- a dead process fails fast --------------------------------------------
{
  const f = fakeRpc();
  const done = wait(f.rpc);
  f.exit(new Error('boom'));
  await assert.rejects(done, /pi exited before the run finished: boom/);
}

console.log('scheduler.check: OK');
