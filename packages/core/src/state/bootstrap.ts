import { asRow, type Db } from './db.ts';

/**
 * bootstrapHistory（§6.2）：绑定后把群里的历史回填进 agent 的只读上下文。
 * 以 (session_id, chat_id) 为主键做幂等 —— 每个群只回填一次。
 */
export interface BootstrapRecord {
  sessionId: string;
  chatId: string;
  lastMsgId?: string;
  count: number;
  text: string;
  fetchedAt: number;
}

interface Row {
  session_id: string;
  chat_id: string;
  last_msg_id: string | null;
  count: number;
  text: string;
  fetched_at: number;
}

const toRecord = (r: Row): BootstrapRecord => ({
  sessionId: r.session_id,
  chatId: r.chat_id,
  ...(r.last_msg_id ? { lastMsgId: r.last_msg_id } : {}),
  count: Number(r.count),
  text: r.text,
  fetchedAt: Number(r.fetched_at),
});

export function getBootstrapRecord(
  db: Db,
  sessionId: string,
  chatId: string,
): BootstrapRecord | undefined {
  const row = asRow<Row>(
    db
      .prepare('SELECT * FROM bootstrap_records WHERE session_id = ? AND chat_id = ?')
      .get(sessionId, chatId),
  );
  return row ? toRecord(row) : undefined;
}

export function saveBootstrapRecord(db: Db, rec: BootstrapRecord): void {
  db.prepare(
    `INSERT INTO bootstrap_records (session_id, chat_id, last_msg_id, count, text, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, chat_id) DO UPDATE SET
       last_msg_id = excluded.last_msg_id, count = excluded.count,
       text = excluded.text, fetched_at = excluded.fetched_at`,
  ).run(rec.sessionId, rec.chatId, rec.lastMsgId ?? null, rec.count, rec.text, rec.fetchedAt);
}
