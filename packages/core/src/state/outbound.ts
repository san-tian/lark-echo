import type { OutboundMessage } from '../types.ts';
import { asRow, asRows, type Db } from './db.ts';

export type OutboundStatus = 'pending' | 'sent' | 'failed';

export interface OutboundRecord {
  id: number;
  turnId: string;
  seq: number;
  chatId: string;
  text: string;
  replyTo?: string;
  status: OutboundStatus;
  attempts: number;
  sentMsgId?: string;
  createdAt: number;
}

interface OutboundRow {
  id: number;
  turn_id: string;
  seq: number;
  chat_id: string;
  text: string;
  reply_to: string | null;
  status: string;
  attempts: number;
  sent_msg_id: string | null;
  created_at: number;
}

const toRecord = (r: OutboundRow): OutboundRecord => ({
  id: Number(r.id),
  turnId: r.turn_id,
  seq: Number(r.seq),
  chatId: r.chat_id,
  text: r.text,
  replyTo: r.reply_to ?? undefined,
  status: r.status as OutboundStatus,
  attempts: Number(r.attempts),
  sentMsgId: r.sent_msg_id ?? undefined,
  createdAt: Number(r.created_at),
});

/**
 * 出站对称落盘 + 幂等（缺口 B）。飞书没有幂等键，靠 `UNIQUE(turn_id, seq)` 保证
 * 重试不会重复发消息。
 */
export function enqueueOutbound(
  db: Db,
  msg: OutboundMessage,
  now = Date.now(),
): OutboundRecord {
  const chatId = msg.conversationKey.replace(/^feishu:chat:/, '');
  db.prepare(
    `INSERT OR IGNORE INTO outbound_messages
       (turn_id, seq, chat_id, text, reply_to, status, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
  ).run(msg.turnId, msg.seq, chatId, msg.text, msg.replyTo ?? null, now);
  const row = asRow<OutboundRow>(
    db.prepare('SELECT * FROM outbound_messages WHERE turn_id = ? AND seq = ?').get(msg.turnId, msg.seq),
  );
  return toRecord(row!);
}

export function listPendingOutbound(db: Db, limit = 50): OutboundRecord[] {
  return asRows<OutboundRow>(
    db
      .prepare(
        `SELECT * FROM outbound_messages WHERE status = 'pending'
         ORDER BY created_at LIMIT ?`,
      )
      .all(limit),
  ).map(toRecord);
}

export function markOutboundSent(db: Db, id: number, sentMsgId: string): void {
  db.prepare(
    `UPDATE outbound_messages SET status = 'sent', sent_msg_id = ?, attempts = attempts + 1
     WHERE id = ?`,
  ).run(sentMsgId, id);
}

export function markOutboundFailed(db: Db, id: number, maxAttempts = 3): void {
  db.prepare(
    `UPDATE outbound_messages
     SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
     WHERE id = ?`,
  ).run(maxAttempts, id);
}

export function listOutboundByTurn(db: Db, turnId: string): OutboundRecord[] {
  return asRows<OutboundRow>(
    db.prepare('SELECT * FROM outbound_messages WHERE turn_id = ? ORDER BY seq').all(turnId),
  ).map(toRecord);
}
