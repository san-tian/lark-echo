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

/* ------------------------------ 全局配置 ------------------------------ */

export const DEFAULT_MODEL_KEY = 'default_model';

/** 默认模型按 agent 分开存（pi / claude / codex 的模型 id 不通用） */
export const defaultModelKey = (agent: string): string => `default_model:${agent}`;

/** 控制台可配置项的 key（§4.4「设置」面板） */
export const SETTINGS = {
  bootstrapEnabled: 'bootstrap.enabled',
  bootstrapMaxMessages: 'bootstrap.max_messages',
  bootstrapMaxAgeDays: 'bootstrap.max_age_days',
  pendingWindowMax: 'pending_window.max_messages',
  codexSandboxMode: 'codex.sandbox_mode',
  /** 告诉 agent 它在哪个群、可以自己发文件（决策 22，默认关） */
  chatToolsEnabled: 'chat_tools.enabled',
} as const;

export function getBool(db: Db, key: string, def: boolean): boolean {
  const v = getSetting(db, key);
  if (v === undefined) return def;
  return v === 'true' || v === '1';
}

export function getInt(db: Db, key: string, def: number): number {
  const v = getSetting(db, key);
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

interface GlobalRow {
  key: string;
  value: string | null;
  updated_at: number;
}

export function getSetting(db: Db, key: string): string | undefined {
  const row = asRow<GlobalRow>(db.prepare('SELECT * FROM settings WHERE key = ?').get(key));
  return row?.value ?? undefined;
}

export function setSetting(db: Db, key: string, value: string | undefined, now = Date.now()): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value ?? null, now);
}

export function listSettings(db: Db): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const row of asRows<GlobalRow>(db.prepare('SELECT * FROM settings').all())) {
    out[row.key] = row.value ?? undefined;
  }
  return out;
}

/* --------------------------- 会话 id 别名映射 --------------------------- */

/**
 * per-turn adapter（claude/codex）只能在第一轮才知道 CLI 真实 session id。
 * 绑定里存的是稳定的逻辑 id，这里存「逻辑 id → 真实 id」，让 daemon 重启后仍能 resume。
 */
export function getSessionAlias(db: Db, logicalId: string): string | undefined {
  const row = asRow<{ real_id: string }>(
    db.prepare('SELECT real_id FROM session_aliases WHERE logical_id = ?').get(logicalId),
  );
  return row?.real_id ?? undefined;
}

export function setSessionAlias(
  db: Db,
  logicalId: string,
  agent: string,
  realId: string,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO session_aliases (logical_id, agent, real_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(logical_id) DO UPDATE SET agent = excluded.agent, real_id = excluded.real_id, updated_at = excluded.updated_at`,
  ).run(logicalId, agent, realId, now);
}
