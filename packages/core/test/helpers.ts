import { openDb, type Db } from '../src/state/db.ts';
import type { ConversationKey, InboundMessage } from '../src/types.ts';

export const memoryDb = (): Db => openDb(':memory:');

export const keyFor = (chatId: string): ConversationKey => `feishu:chat:${chatId}`;

let seq = 0;
export const inbound = (partial: Partial<InboundMessage> & { chatId: string }): InboundMessage => {
  seq += 1;
  const { chatId, ...rest } = partial;
  return {
    id: rest.id ?? `evt-${seq}`,
    channel: 'feishu',
    conversationKey: keyFor(chatId),
    actor: rest.actor ?? { id: 'ou_owner', name: '张三' },
    text: rest.text ?? 'hello',
    attachments: rest.attachments ?? [],
    ts: rest.ts ?? Date.now(),
    mentioned: rest.mentioned ?? true,
    ...(rest.threadId ? { threadId: rest.threadId } : {}),
    ...(rest.replyTo ? { replyTo: rest.replyTo } : {}),
  };
};

export async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 2000, intervalMs = 5 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!predicate()) throw new Error('waitFor timed out');
}
