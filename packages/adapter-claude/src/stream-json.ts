/**
 * `claude -p --output-format stream-json --verbose [--include-partial-messages]` 的事件形状。
 *
 * 全部字段来自 **实测**（claude 2.1.258），原始输出见 docs/spikes/04-claude-adapter.md。
 * 事件是一行一个 JSON（LF 分隔），外加可能出现的非 JSON 行（stderr 才是主要来源，但 CLI
 * 也会往 stdout 打诊断），所以解析必须容忍失败。
 */

export type ClaudeStreamMessage = Record<string, unknown> & { type: string };

/** `{"type":"system","subtype":"init", ...}`：进程启动后第一行，携带真实 session_id */
export interface ClaudeSystemInit extends Record<string, unknown> {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd?: string;
  model?: string;
  /** 未传 --permission-mode 时是 "default" */
  permissionMode?: string;
  tools?: string[];
  claude_code_version?: string;
}

/** `subtype: "status" | "thinking_tokens" | "permission_denied" | ...` */
export interface ClaudeSystemEvent extends Record<string, unknown> {
  type: 'system';
  subtype: string;
  session_id?: string;
  /** 仅 permission_denied */
  tool_name?: string;
  tool_use_id?: string;
  message?: string;
}

/** `--include-partial-messages` 的增量事件（Anthropic streaming 事件原样透传） */
export interface ClaudeStreamEvent extends Record<string, unknown> {
  type: 'stream_event';
  session_id?: string;
  event: {
    type: string; // message_start | content_block_start | content_block_delta | content_block_stop | message_delta | message_stop
    index?: number;
    delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string | null };
    content_block?: { type?: string; text?: string };
  };
}

export interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

export interface ClaudeAssistantEvent extends Record<string, unknown> {
  type: 'assistant';
  session_id?: string;
  parent_tool_use_id?: string | null;
  message?: { role?: string; content?: ClaudeContentBlock[]; model?: string };
}

export interface ClaudeUserEvent extends Record<string, unknown> {
  type: 'user';
  session_id?: string;
  parent_tool_use_id?: string | null;
  message?: { role?: string; content?: string | ClaudeContentBlock[] };
}

/** turn 的终态事件：最终文本在 `result` 字段 */
export interface ClaudeResultEvent extends Record<string, unknown> {
  type: 'result';
  /** success | error_during_execution | ... */
  subtype: string;
  session_id?: string;
  is_error?: boolean;
  /** 最终 assistant 文本；中断/无文本时是 null */
  result?: string | null;
  num_turns?: number;
  terminal_reason?: string;
  errors?: string[];
  permission_denials?: { tool_name?: string; tool_use_id?: string; tool_input?: unknown }[];
}

/** 单行解析；非 JSON / 空行返回 undefined */
export function parseStreamLine(line: string): ClaudeStreamMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== 'string') return undefined;
    return parsed as ClaudeStreamMessage;
  } catch {
    return undefined;
  }
}

/** 流式文本增量：`stream_event` + `content_block_delta` + `delta.type === "text_delta"` */
export function deltaText(msg: ClaudeStreamMessage): string | undefined {
  if (msg.type !== 'stream_event') return undefined;
  const event = (msg as ClaudeStreamEvent).event;
  if (!event || event.type !== 'content_block_delta') return undefined;
  if (event.delta?.type !== 'text_delta') return undefined;
  return typeof event.delta.text === 'string' ? event.delta.text : undefined;
}

/** assistant 消息里的 tool_use 名字（`--include-partial-messages` 下与 delta 并存，不重复计数文本） */
export function toolUseNames(msg: ClaudeStreamMessage): string[] {
  if (msg.type !== 'assistant') return [];
  const content = (msg as ClaudeAssistantEvent).message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block?.type === 'tool_use' && typeof block.name === 'string' ? [block.name] : [],
  );
}

/** assistant 消息里的 text 块拼接（没有 partial messages 时的兜底文本来源） */
export function assistantText(msg: ClaudeStreamMessage): string {
  if (msg.type !== 'assistant') return '';
  const content = (msg as ClaudeAssistantEvent).message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('');
}

/** 任何事件都可能带 session_id（init / 每个 stream_event / result 都有） */
export function sessionIdOf(msg: ClaudeStreamMessage): string | undefined {
  const sid = msg.session_id;
  return typeof sid === 'string' && sid ? sid : undefined;
}
