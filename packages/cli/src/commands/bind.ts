import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  deleteBinding,
  getSessionModel,
  insertBinding,
  isMirrorMode,
  listBindings,
  openDb,
  setMirrorMode,
  MIRROR_MODES,
  type Binding,
} from '@anylark/core';
import { bool, flag, type Args } from '../args.ts';
import { fail, ok, print } from '../io.ts';
import { withDaemon } from '../daemon-client.ts';
import { listChats } from '../chats.ts';
import { promptVisible } from '../tty.ts';
import { formatBindings } from './bindings-table.ts';
import type { SessionRow } from './session.ts';

/** 从 ~/.pi/agent/sessions/ 里猜这个 cwd 最近用的会话 id */
function piSessionIdFor(cwd: string): string | undefined {
  const slug = `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`;
  const dir = join(homedir(), '.pi', 'agent', 'sessions', slug);
  if (!existsSync(dir)) return undefined;
  const newest = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  return newest?.f.match(/_([^_]+)\.jsonl$/)?.[1];
}

async function pickChat(): Promise<string | undefined> {
  const chats = await listChats();
  if (chats.length === 0) {
    fail('机器人不在任何群里，先把机器人拉进目标群');
    return undefined;
  }
  print('机器人所在的群：');
  chats.forEach((c, i) => print(`  ${i + 1}. ${c.name}  (${c.chatId})`));
  const answer = await promptVisible('选择序号: ');
  const idx = Number(answer) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= chats.length) {
    fail('无效的选择');
    return undefined;
  }
  return chats[idx]!.chatId;
}

export async function cmdBind(args: Args): Promise<number> {
  const cwd = resolve(flag(args, 'cwd') ?? process.cwd());
  const sessionId = flag(args, 'session') ?? piSessionIdFor(cwd);
  if (!sessionId) {
    fail(`无法自动识别 pi 会话（cwd=${cwd}），请显式指定 --session <id>`);
    return 1;
  }
  const owner = flag(args, 'owner') ?? (bool(args, 'anyone') ? '*' : undefined);
  if (!owner) {
    fail('必须指定 --owner <open_id>（或本地调试用 --anyone）');
    return 1;
  }
  const chatId = flag(args, 'chat') ?? (await pickChat());
  if (!chatId) return 1;

  const binding: Binding = {
    chatId,
    sessionId,
    agent: (flag(args, 'agent') ?? 'pi') as Binding['agent'],
    cwd,
    ownerOpenId: owner,
    mirrorMode: 'off',
    createdAt: Date.now(),
  };
  try {
    // daemon 在就走它（它要更新内存里的路由表）；不在才直接写库
    const created =
      (await withDaemon((c) => c.call<Binding>('bind.add', { ...binding }))) ??
      insertBinding(openDb(), binding);
    ok(`已绑定 ${created.chatId} → session ${created.sessionId}`);
    print(`  agent: ${created.agent}  cwd: ${created.cwd}  owner: ${created.ownerOpenId}`);
    return 0;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export async function cmdUnbind(args: Args): Promise<number> {
  const chatId = args.positional[1] ?? flag(args, 'chat');
  if (!chatId) {
    print('用法: anylark unbind <chat_id>');
    return 1;
  }
  const res = await withDaemon((c) => c.call<{ removed: boolean }>('bind.remove', { chatId }));
  const removed = res?.removed ?? deleteBinding(openDb(), chatId);
  if (!removed) {
    fail(`${chatId} 没有绑定`);
    return 1;
  }
  ok(`已解绑 ${chatId}`);
  return 0;
}

export async function cmdMirror(args: Args): Promise<number> {
  const chatId = args.positional[1];
  const mode = args.positional[2];
  if (!chatId || !mode || !isMirrorMode(mode)) {
    print(`用法: anylark mirror <chat_id> <${MIRROR_MODES.join('|')}>`);
    return 1;
  }
  const res = await withDaemon((c) => c.call<{ updated: boolean }>('mirror.set', { chatId, mode }));
  const updated = res?.updated ?? setMirrorMode(openDb(), chatId, mode);
  if (!updated) {
    fail(`${chatId} 没有绑定`);
    return 1;
  }
  ok(`${chatId} mirror = ${mode}`);
  return 0;
}

export async function cmdBindings(): Promise<number> {
  const bindings =
    (await withDaemon((c) => c.call<Binding[]>('bind.list'))) ?? listBindings(openDb());
  if (bindings.length === 0) {
    print('没有绑定。用 anylark bind 创建一个。');
    return 0;
  }
  // 运行中的会话可能已切过模型，优先用它上报的；否则回落到库里存的
  const sessions = (await withDaemon((c) => c.call<SessionRow[]>('session.list'))) ?? [];
  const live = new Map(sessions.map((s) => [s.ref.sessionId, s.model]));
  const db = openDb();
  const modelOf = (sessionId: string): string | undefined =>
    live.get(sessionId) ?? getSessionModel(db, sessionId);
  for (const line of formatBindings(bindings, modelOf)) print(line);
  return 0;
}
