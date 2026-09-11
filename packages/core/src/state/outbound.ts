import type { Attachment, OutboundMessage } from '../types.ts';
import { asRow, asRows, type Db } from './db.ts';

export type OutboundStatus = 'pending' | 'sent' | 'failed';

export interface OutboundRecord {
  id: number;
  turnId: string;
  seq: number;
  chatId: string;
  text: string;
  /** 附件（决策 23）；与 text 互斥但不强制 —— 都是「这一条要发出去的东西」 */
  attachments?: Attachment[];
  replyTo?: string;
  /** 回复要落在话题里（决策 24） */
  replyInThread: boolean;
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
  reply_in_thread: number;
  status: string;
  attempts: number;
  sent_msg_id: string | null;
  created_at: number;
  media: string | null;
}

const toRecord = (r: OutboundRow): OutboundRecord => ({
  id: Number(r.id),
  turnId: r.turn_id,
  seq: Number(r.seq),
  chatId: r.chat_id,
  text: r.text,
  ...(parseMedia(r.media) ? { attachments: parseMedia(r.media)! } : {}),
  replyTo: r.reply_to ?? undefined,
  replyInThread: Boolean(r.reply_in_thread),
  status: r.status as OutboundStatus,
  attempts: Number(r.attempts),
  sentMsgId: r.sent_msg_id ?? undefined,
  createdAt: Number(r.created_at),
});

/** 坏 JSON 当作没附件：宁可少发一条，也不能让整个出站队列卡死 */
function parseMedia(raw: string | null): Attachment[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as Attachment[]) : undefined;
  } catch {
    return undefined;
  }
}

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
       (turn_id, seq, chat_id, text, reply_to, reply_in_thread, status, attempts, created_at, media)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  ).run(
    msg.turnId,
    msg.seq,
    chatId,
    msg.text,
    msg.replyTo ?? null,
    msg.replyInThread ? 1 : 0,
    now,
    msg.attachments?.length ? JSON.stringify(msg.attachments) : null,
  );
  const row = asRow<OutboundRow>(
    db.prepare('SELECT * FROM outbound_messages WHERE turn_id = ? AND seq = ?').get(msg.turnId, msg.seq),
  );
  return toRecord(row!);
}

export function listPendingOutbound(db: Db, limit = 50): OutboundRecord[] {
  return asRows<OutboundRow>(
    db
      .prepare(
        // `created_at` 只到毫秒，同一个 turn 的多个分片基本同刻 —— 不带上 id 排序就
        // 可能乱序发出（分片顺序 / 附件排在文本之后都靠它）
        `SELECT * FROM outbound_messages WHERE status = 'pending'
         ORDER BY created_at, id LIMIT ?`,
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

/** 配置台用：丢弃一条出站消息（不再重试） */
export function discardOutbound(db: Db, id: number): boolean {
  return (
    Number(
      db
        .prepare(`UPDATE outbound_messages SET status = 'failed' WHERE id = ? AND status = 'pending'`)
        .run(id).changes,
    ) > 0
  );
}
