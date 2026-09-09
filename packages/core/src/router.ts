import type { ConversationKey, InboundMessage, SessionRef } from './types.ts';
import { getBinding } from './state/bindings.ts';
import type { Db } from './state/db.ts';

export const conversationKeyFor = (chatId: string): ConversationKey => `feishu:chat:${chatId}`;
export const chatIdOfKey = (key: ConversationKey): string => key.replace(/^feishu:chat:/, '');

export type InboundDecision =
  | { action: 'trigger'; binding: NonNullable<ReturnType<typeof getBinding>> }
  | { action: 'context'; binding: NonNullable<ReturnType<typeof getBinding>> }
  | { action: 'unbound' }
  | { action: 'thread-unsupported'; binding: NonNullable<ReturnType<typeof getBinding>> };

/**
 * 入站分流（§4.3 / §8）：
 * - 未绑定 → unbound（忽略 + 回「未绑定」）
 * - 话题群 → thread-unsupported（缺口 H：M0 明确提示不支持）
 * - 绑定者 @机器人 → trigger
 * - 其他一切 → context（进 pendingWindow，`contextVisibility: "all"`）
 */
export function decideInbound(db: Db, msg: InboundMessage): InboundDecision {
  const chatId = chatIdOfKey(msg.conversationKey);
  const binding = getBinding(db, chatId);
  if (!binding) return { action: 'unbound' };
  if (msg.threadId) return { action: 'thread-unsupported', binding };
  if (msg.mentioned && msg.actor.id === binding.ownerOpenId) return { action: 'trigger', binding };
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
