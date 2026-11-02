/** A turn in progress must never be idle-terminated, and a session instance the
 *  process manager no longer tracks must only reap itself. */
import assert from 'node:assert';
import { UserSession } from './user-session.js';

const IDLE_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const win = IDLE_MS * 2.5;

// --- a long turn that keeps streaming events -------------------------------
{
  const s: any = new UserSession('admin', null, {}, IDLE_MS, { autoName: false, restartable: false });
  let kills = 0;
  let onEvent: any;
  s.rpc.onEvent = (h: any) => { onEvent = h; };
  s.onIdle(() => { kills++; });
  s.registerEventHandlers();

  onEvent({ type: 'agent_start' });
  // Turn outlives the idle window several times over, as a real one would
  for (let i = 0; i < 4; i++) {
    await sleep(IDLE_MS);
    onEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } });
  }
  assert.equal(kills, 0, 'idle timeout killed a turn that was still streaming');

  // Turn over — the idle timer may fire now
  onEvent({ type: 'agent_settled' });
  await sleep(win);
  assert.equal(kills, 1, 'idle timeout did not fire for an idle session');
  try { await s.stop(); } catch { /* never started */ }
}

// --- long tool run with no events at all, plus a compaction ----------------
{
  const s: any = new UserSession('admin', null, {}, IDLE_MS, { autoName: false, restartable: false });
  let kills = 0;
  s.onIdle(() => { kills++; });
  s.state.sessionState.isStreaming = true; // agent_start arrived, tool is silent
  s.touch();
  await sleep(win * 2);
  assert.equal(kills, 0, 'idle timeout killed a silent but running turn');

  s.state.sessionState.isStreaming = false;
  s.state.sessionState.compacting = true;
  s.touch();
  await sleep(win * 2);
  assert.equal(kills, 0, 'idle timeout killed a running compaction');

  s.state.sessionState.compacting = false;
  s.touch();
  await sleep(win);
  assert.equal(kills, 1, 'idle timeout did not fire after the turn');
  try { await s.stop(); } catch { /* never started */ }
}

console.log('idle-timeout.check: OK');
