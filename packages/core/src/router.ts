import type { ConversationKey, InboundMessage, SessionRef } from './types.ts';
import { getBinding } from './state/bindings.ts';
import type { Db } from './state/db.ts';

export const conversationKeyFor = (chatId: string): ConversationKey => `feishu:chat:${chatId}`;
export const chatIdOfKey = (key: ConversationKey): string => key.replace(/^feishu:chat:/, '');

export type InboundDecision =
  | { action: 'trigger'; binding: NonNullable<ReturnType<typeof getBinding>> }
  | { action: 'context'; binding: NonNullable<ReturnType<typeof getBinding>> }
  | { action: 'unbound' };

/**
 * 入站分流（§4.3 / §8）：
 * - 未绑定 → unbound（忽略 + 回「未绑定」）
 * - 绑定者 @机器人 → trigger（`ownerOpenId === '*'` 表示任何人，仅用于本地调试）
 * - 其他一切 → context（进 pendingWindow，`contextVisibility: "all"`）
 *
 * 话题群按普通群处理（决策 24）：会话/绑定仍是 chat 维度，只有回复要落进话题。
 */
export function decideInbound(db: Db, msg: InboundMessage): InboundDecision {
  const chatId = chatIdOfKey(msg.conversationKey);
  const binding = getBinding(db, chatId);
  if (!binding) return { action: 'unbound' };
  if (msg.mentioned && (binding.ownerOpenId === '*' || msg.actor.id === binding.ownerOpenId)) {
    return { action: 'trigger', binding };
  }
  return { action: 'context', binding };
}

export function sessionRefFor(db: Db, chatId: string): SessionRef | undefined {
  const binding = getBinding(db, chatId);
  if (!binding) return undefined;
  return {
    agent: binding.agent,
    sessionId: binding.sessionId,
    cwd: binding.cwd,
    driver: 'daemon',
  };
}
