import type { InboundMessage } from '../types.ts';
import { asRow, asRows, type Db } from './db.ts';

export type InboundStatus = 'pending' | 'dispatched' | 'context' | 'done' | 'dropped';

interface InboundRow {
  event_id: string;
  chat_id: string;
  session_id: string | null;
  mentioned: number;
  payload: string;
  received_at: number;
  status: string;
}

const toMessage = (r: InboundRow): InboundMessage => JSON.parse(r.payload) as InboundMessage;

/**
 * 入站先落盘再分发（§10.1）。`event_id` 是主键 —— 重复事件直接被数据库挡掉。
 * @returns false 表示重复事件（已处理过）
 */
export function recordInbound(
  db: Db,
  msg: InboundMessage,
  sessionId: string | null,
): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO inbound_events
         (event_id, chat_id, session_id, mentioned, actor_id, actor_name, text, payload, received_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      msg.id,
      chatIdOf(msg),
      sessionId,
      msg.mentioned ? 1 : 0,
      msg.actor.id,
      msg.actor.name,
      msg.text,
      JSON.stringify(msg),
      msg.ts,
      msg.mentioned ? 'pending' : 'context',
    );
  return Number(res.changes) > 0;
}

export function chatIdOf(msg: InboundMessage): string {
  return msg.conversationKey.replace(/^feishu:chat:/, '');
}

export function markInbound(db: Db, eventId: string, status: InboundStatus, now = Date.now()): void {
  db.prepare(
    'UPDATE inbound_events SET status = ?, consumed_at = ? WHERE event_id = ?',
  ).run(status, status === 'done' || status === 'dropped' ? now : null, eventId);
}

export function listPendingInbound(db: Db, limit = 50): InboundMessage[] {
  const rows = asRows<InboundRow>(
    db
      .prepare(
        `SELECT * FROM inbound_events WHERE status = 'pending'
       ORDER BY received_at LIMIT ?`,
      )
      .all(limit),
  );
  return rows.map(toMessage);
}

/** 待处理窗口：该群「未 @ 机器人」的旁观消息（§6.1） */
export function pendingWindowFor(db: Db, chatId: string, limit = 50): InboundMessage[] {
  const rows = asRows<InboundRow>(
    db
      .prepare(
        `SELECT * FROM inbound_events
       WHERE chat_id = ? AND status = 'context'
       ORDER BY received_at DESC LIMIT ?`,
      )
      .all(chatId, limit),
  );
  return rows.reverse().map(toMessage);
}

/** 该群回复后清空窗口 —— 只清这个群的（§6.1） */
export function clearPendingWindow(db: Db, chatId: string, now = Date.now()): number {
  return Number(
    db
      .prepare(
        `UPDATE inbound_events SET status = 'done', consumed_at = ?
         WHERE chat_id = ? AND status = 'context'`,
      )
      .run(now, chatId).changes,
  );
}

export function countPendingInbound(db: Db): number {
  const row = asRow<{ n: number }>(
    db.prepare(`SELECT COUNT(*) AS n FROM inbound_events WHERE status = 'pending'`).get(),
  );
  return Number(row?.n ?? 0);
}
