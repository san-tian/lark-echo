import { getSessionModel, openDb, setSessionModel } from '@instead/core';
import { flag, type Args } from '../args.ts';
import { fail, ok, print } from '../io.ts';
import { withDaemon } from '../daemon-client.ts';

export interface SessionRow {
  ref: { sessionId: string; agent: string; cwd: string };
  idleMs: number;
  model?: string;
}

export async function cmdModel(args: Args): Promise<number> {
  const sessionId = args.positional[1];
  const model = args.positional[2];
  if (!sessionId) {
    print('用法: instead model <session_id> [<provider>/<model>]');
    return 1;
  }
  if (!model) {
    const current = getSessionModel(openDb(), sessionId);
    print(`${sessionId}: ${current ?? '(agent 默认模型)'}`);
    return 0;
  }
  const res = await withDaemon((c) =>
    c.call<{ model?: string; applied: string }>('session.setModel', { sessionId, model }),
  );
  if (!res) {
    setSessionModel(openDb(), sessionId, model);
    ok(`已记录 ${sessionId} → ${model}（daemon 未运行，下次启动生效）`);
    return 0;
  }
  ok(
    res.applied === 'runtime'
      ? `${sessionId} 已切换到 ${model}（立即生效）`
      : `${sessionId} 已记录 ${model}（下次启动该会话生效）`,
  );
  return 0;
}

export async function cmdModels(args: Args): Promise<number> {
  const sessionId = args.positional[1];
  if (!sessionId) {
    print('用法: instead models <session_id>');
    return 1;
  }
  const res = await withDaemon((c) =>
    c.call<{ models?: { id: string; label?: string; provider?: string }[]; running: boolean }>(
      'session.models',
      { sessionId },
    ),
  );
  if (!res) {
    fail('daemon 未运行，无法列出模型');
    return 1;
  }
  if (!res.running) {
    fail(`会话 ${sessionId} 未运行（先在群里发一条消息让它启动，再查）`);
    return 1;
  }
  for (const m of res.models ?? []) {
    print(`${m.provider ? `${m.provider}/` : ''}${m.id}${m.label ? `  ${m.label}` : ''}`);
  }
  if (!res.models?.length) print('（adapter 未提供模型列表）');
  return 0;
}

export async function cmdSessions(args: Args): Promise<number> {
  const release = flag(args, 'release');
  if (release) {
    // daemon 不在、或那个会话本来就没在跑 —— 都别谎报成功
    const res = await withDaemon((c) =>
      c.call<{ released: boolean }>('session.release', { sessionId: release }),
    );
    if (res === undefined) {
      fail('daemon 未运行，没有会话可释放');
      return 1;
    }
    if (!res.released) {
      fail(`会话 ${release} 没有在运行`);
      return 1;
    }
    ok(`已释放 ${release}`);
    return 0;
  }
  const sessions = await withDaemon((c) => c.call<SessionRow[]>('session.list'));
  if (!sessions) {
    fail('daemon 未运行');
    return 1;
  }
  if (sessions.length === 0) {
    print('没有运行中的会话');
    return 0;
  }
  for (const s of sessions) {
    print(
      `${s.ref.sessionId}  [${s.ref.agent}]  idle=${Math.round(s.idleMs / 1000)}s  model=${s.model ?? '-'}\n    cwd: ${s.ref.cwd}`,
    );
  }
  return 0;
}
