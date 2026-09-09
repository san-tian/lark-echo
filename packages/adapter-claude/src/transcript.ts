/**
 * Claude Code 的会话转录：`~/.claude/projects/<slug>/<session_id>.jsonl`
 *
 * 实测（claude 2.1.258）：
 * - 目录名 = cwd 的所有非字母数字字符替换成 `-`（`/tmp/claude.spike_x` → `-tmp-claude-spike-x`）
 * - `CLAUDE_CONFIG_DIR` 会同时改掉 CLI 的 config 目录，所以 projects 根目录跟随它
 * - 一行一个 JSON 条目，`type` 有 user / assistant / attachment / queue-operation / last-prompt / ...
 * - 子 agent（sidechain）条目带 `isSidechain: true`，必须跳过
 * - `--resume` 跨目录续跑时，新条目仍写回**会话创建时**的 cwd 目录
 */

import { createReadStream, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { HistoryEntry } from '@lark-echo/core';

export interface TranscriptRaw {
  type?: string;
  isSidechain?: boolean;
  uuid?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}

/** cwd → projects 下的目录名 */
export const encodeProjectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/** `~/.claude/projects`（`CLAUDE_CONFIG_DIR` 优先） */
export function claudeProjectsRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return configDir ? join(configDir, 'projects') : join(homedir(), '.claude', 'projects');
}

export function transcriptPath(
  cwd: string,
  sessionId: string,
  root: string = claudeProjectsRoot(),
): string {
  return join(root, encodeProjectSlug(cwd), `${sessionId}.jsonl`);
}

export function transcriptExists(
  cwd: string,
  sessionId: string,
  root: string = claudeProjectsRoot(),
): boolean {
  return existsSync(transcriptPath(cwd, sessionId, root));
}

/** 把 message.content（string | block[]）压成纯文本，丢弃 thinking / tool_use / tool_result */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => {
      const b = block as { type?: string; text?: string } | null;
      return b?.type === 'text' && typeof b.text === 'string' ? [b.text] : [];
    })
    .join('');
}

/**
 * 转录条目 → HistoryEntry。
 * 跳过：sidechain（子 agent）、非 user/assistant、以及只剩 tool_result 的 user 条目。
 */
export function toHistoryEntry(raw: unknown): HistoryEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const entry = raw as TranscriptRaw;
  if (entry.isSidechain === true) return undefined;
  const type = entry.type;
  if (type !== 'user' && type !== 'assistant') return undefined;
  const role = entry.message?.role;
  const resolved = role === 'user' || role === 'assistant' ? role : type;
  const text = contentText(entry.message?.content).trim();
  if (!text) return undefined;
  const id = typeof entry.uuid === 'string' ? entry.uuid : `${type}-${entry.timestamp ?? ''}`;
  const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
  return { id, role: resolved, text, ...(Number.isNaN(ts) ? {} : { ts }) };
}

/**
 * 读转录文件，按行 yield。
 * `cursor` 为上次最后一条的 `id`：跳过它之前（含它）的所有条目。
 * 文件不存在时直接返回空（会话还没落盘 / 已被删）。
 */
export async function* readTranscript(file: string, cursor?: string): AsyncIterable<HistoryEntry> {
  if (!existsSync(file)) return;
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let pastCursor = cursor === undefined;
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        continue; // 转录里偶有非 JSON 行，跳过
      }
      const entry = toHistoryEntry(raw);
      if (!pastCursor) {
        if (entry && entry.id === cursor) pastCursor = true;
        continue;
      }
      if (entry) yield entry;
    }
  } finally {
    rl.close();
  }
}
