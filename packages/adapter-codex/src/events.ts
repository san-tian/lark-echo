/**
 * `codex exec --json` 的 NDJSON 事件解析（真实形状见 docs/spikes/05-codex-adapter.md §1.1）。
 */

export interface CodexJsonEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexItem {
  type?: string;
  id?: string;
  text?: string;
  message?: string;
  name?: string;
  command?: unknown;
  [key: string]: unknown;
}

/** 单行 JSONL → 事件；空行 / 非 JSON / 缺 type 返回 undefined（不抛） */
export function parseCodexLine(line: string): CodexJsonEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string') return undefined;
  return parsed as CodexJsonEvent;
}

export function codexItem(event: CodexJsonEvent): CodexItem | undefined {
  const item = event.item;
  if (!item || typeof item !== 'object') return undefined;
  return item as CodexItem;
}

/** 错误文本：顶层 message / error.message / item.message 三种都见过 */
export function extractErrorMessage(event: CodexJsonEvent): string | undefined {
  if (typeof event.message === 'string' && event.message) return event.message;
  const err = event.error;
  if (typeof err === 'string' && err) return err;
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  const item = codexItem(event);
  if (item && typeof item.message === 'string' && item.message) return item.message;
  return undefined;
}

/** 非 agent_message 的 item → tool 标签 */
export function toolLabel(item: CodexItem): string | undefined {
  const command = item.command;
  if (typeof command === 'string' && command) return command;
  if (Array.isArray(command) && command.length > 0) return command.map(String).join(' ');
  if (typeof item.name === 'string' && item.name) return `${item.type ?? 'tool'}: ${item.name}`;
  if (typeof item.type === 'string' && item.type && item.type !== 'agent_message') return item.type;
  return undefined;
}
