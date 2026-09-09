import { DatabaseSync } from 'node:sqlite';
import { ensureHome, paths } from '../paths.ts';

/**
 * 唯一直接触碰 node:sqlite 的模块（PLAN §2.3）。
 * 换 better-sqlite3 时只改这里。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bindings (
  chat_id       TEXT PRIMARY KEY,          -- chat 1:1 session 的机制保证（§1.1）
  session_id    TEXT NOT NULL,
  agent         TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  owner_open_id TEXT NOT NULL,
  mirror_mode   TEXT NOT NULL DEFAULT 'off',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bindings_session ON bindings(session_id);

CREATE TABLE IF NOT EXISTS bind_codes (
  code       TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,         -- 单条 session 同时只有一个有效码（§1.2）
  agent      TEXT NOT NULL,
  cwd        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_events (
  event_id    TEXT PRIMARY KEY,            -- 渠道事件 id，去重键
  chat_id     TEXT NOT NULL,
  session_id  TEXT,
  mentioned   INTEGER NOT NULL,
  actor_id    TEXT NOT NULL,
  actor_name  TEXT,
  text        TEXT NOT NULL,
  payload     TEXT NOT NULL,               -- 完整 InboundMessage JSON
  received_at INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|dispatched|done|dropped
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inbound_pending ON inbound_events(status, chat_id, received_at);

CREATE TABLE IF NOT EXISTS outbound_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  chat_id    TEXT NOT NULL,
  text       TEXT NOT NULL,
  reply_to   TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending|sent|failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_msg_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(turn_id, seq)                     -- 出站幂等（缺口 B）
);
CREATE INDEX IF NOT EXISTS idx_outbound_pending ON outbound_messages(status, created_at);

CREATE TABLE IF NOT EXISTS session_settings (
  session_id TEXT PRIMARY KEY,
  model      TEXT,                          -- <provider>/<modelId>，为空表示用 agent 自己的默认值
  updated_at INTEGER NOT NULL
);
`;

export type Db = DatabaseSync;

export function openDb(file: string = paths.stateDb()): Db {
  if (file !== ':memory:') ensureHome();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export function closeDb(db: Db): void {
  db.close();
}

/** node:sqlite 返回 Record<string, SQLOutputValue>，统一在这里收口 */
export const asRows = <T>(rows: unknown): T[] => rows as T[];
export const asRow = <T>(row: unknown): T | undefined => row as T | undefined;
