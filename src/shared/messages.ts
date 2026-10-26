/**
 * How a send request maps onto pi's RPC verbs (shared by the backend route
 * and its checks).
 *
 * - steer/followUp while idle would be queued by pi forever (it never starts
 *   a turn), so they degrade to a prompt.
 * - a prompt while streaming would fail with "already processing", so it is
 *   queued as a steer — the target acts on it in the current turn.
 */
export type MessageType = 'prompt' | 'steer' | 'followUp';

export interface EffectiveMessage {
  type: MessageType;
  /** true when the message is queued behind the target's current turn */
  queued: boolean;
}

export function effectiveMessageType(requested: MessageType, streaming: boolean): EffectiveMessage {
  if (!streaming) return { type: 'prompt', queued: false };
  return { type: requested === 'prompt' ? 'steer' : requested, queued: true };
}
