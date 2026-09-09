import { asRow, asRows, type Db } from './db.ts';

export interface SessionSettings {
  sessionId: string;
  model?: string;
  updatedAt: number;
}

interface SettingsRow {
  session_id: string;
  model: string | null;
  updated_at: number;
}

const toSettings = (r: SettingsRow): SessionSettings => ({
  sessionId: r.session_id,
  ...(r.model ? { model: r.model } : {}),
  updatedAt: Number(r.updated_at),
});

export function getSessionSettings(db: Db, sessionId: string): SessionSettings | undefined {
  const row = asRow<SettingsRow>(
    db.prepare('SELECT * FROM session_settings WHERE session_id = ?').get(sessionId),
  );
  return row ? toSettings(row) : undefined;
}

export function getSessionModel(db: Db, sessionId: string): string | undefined {
  return getSessionSettings(db, sessionId)?.model;
}

export function setSessionModel(db: Db, sessionId: string, model: string | undefined, now = Date.now()): void {
  db.prepare(
    `INSERT INTO session_settings (session_id, model, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at`,
  ).run(sessionId, model ?? null, now);
}

export function listSessionSettings(db: Db): SessionSettings[] {
  return asRows<SettingsRow>(
    db.prepare('SELECT * FROM session_settings ORDER BY updated_at DESC').all(),
  ).map(toSettings);
}
