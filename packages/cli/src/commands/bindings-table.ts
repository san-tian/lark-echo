import type { Binding } from '@anylark/core';
import { table } from '../io.ts';

/** 绑定总览的表格排版。纯函数：模型查询由调用方注入，便于测试。 */
export function formatBindings(
  bindings: Binding[],
  modelOf: (sessionId: string) => string | undefined,
): string[] {
  return table(
    ['CHAT', 'SESSION', 'AGENT', 'MIRROR', 'MODEL', 'OWNER'],
    bindings.map((b) => [
      b.chatId,
      b.sessionId,
      b.agent,
      b.mirrorMode,
      modelOf(b.sessionId) ?? '-',
      b.ownerOpenId,
    ]),
  );
}
