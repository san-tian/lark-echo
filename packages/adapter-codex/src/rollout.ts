import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { HistoryEntry } from '@instead/core';

/**
 * Codex rollout JSONL 读取（best-effort，见 docs/spikes/05-codex-adapter.md §1.7）。
 *
 * 布局：`<sessionsDir>/YYYY/MM/DD/rollout-<ISO>-<thread_id>.jsonl`
 * 只取 `event_msg` + `payload.type === "item_completed"`：
 * `response_item` 里 role=user 的条目混着 `<environment_context>` 等系统注入，不能当用户消息。
 */

/** 按 thread id 找 rollout 文件；找不到返回 undefined（CLI 迁移存储后可能失效） */
export function findRolloutFile(sessionsDir: string, threadId: string): string | undefined {
  if (!threadId || !existsSync(sessionsDir)) return undefined;
  const suffix = `-${threadId}.jsonl`;
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir, { recursive: true, encoding: 'utf8' });
  } catch {
    return undefined;
  }
  for (const relative of entries) {
    if (relative.endsWith(suffix)) return join(sessionsDir, relative);
  }
  return undefined;
}

/** 游标 = rollout 顶层的 `ordinal`（整数）；只 yield ordinal 大于游标的条目 */
export async function* readRolloutHistory(
  file: string,
  cursor?: string,
): AsyncGenerator<HistoryEntry> {
  const from = cursor ? Number.parseInt(cursor, 10) : Number.NaN;
  const reader = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (record.type !== 'event_msg') continue;
      const ordinal = typeof record.ordinal === 'number' ? record.ordinal : undefined;
      if (Number.isFinite(from) && ordinal !== undefined && ordinal <= from) continue;
      const payload = record.payload;
      if (!payload || typeof payload !== 'object') continue;
      if ((payload as { type?: unknown }).type !== 'item_completed') continue;
      const item = (payload as { item?: unknown }).item;
      const entry = toHistoryEntry(item, ordinal, record.timestamp);
      if (entry) yield entry;
    }
  } finally {
    reader.close();
  }
}

function toHistoryEntry(
  item: unknown,
  ordinal: number | undefined,
  timestamp: unknown,
): HistoryEntry | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const record = item as Record<string, unknown>;
  // id 用顶层 ordinal：history 的 cursor 就是 ordinal，必须能原样回传（同 pi 的 entry.id 语义）
  const id = String(ordinal ?? record.id ?? 'unknown');
  const ts = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
  const withTs = Number.isFinite(ts) ? { ts } : {};

  switch (record.type) {
    case 'UserMessage':
      return { id, role: 'user', text: textFromContent(record.content), ...withTs };
    case 'AgentMessage':
      return { id, role: 'assistant', text: textFromContent(record.content), ...withTs };
    case 'CommandExecution': {
      const command = record.command;
      const text = Array.isArray(command)
        ? command.map(String).join(' ')
        : typeof command === 'string'
          ? command
          : '';
      return text ? { id, role: 'other', text, ...withTs } : undefined;
    }
    default:
      return undefined;
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (!block || typeof block !== 'object') return '';
      const record = block as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text; // text / Text / input_text / output_text
      if (record.type === 'local_image') return '[图片]';
      return '';
    })
    .filter((part) => part.length > 0)
    .join('\n');
}
