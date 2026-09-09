import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureHome,
  getSessionModel,
  insertBinding,
  deleteBinding,
  listBindings,
  loadCredential,
  listCredentials,
  openDb,
  paths,
  revokeCredential,
  saveCredential,
  setMirrorMode,
  setSessionModel,
  type Binding,
  type DoctorCheck,
} from '@lark-echo/core';
import { IpcClient } from '@lark-echo/daemon';
import { FeishuChannel, verifyCredentials } from '@lark-echo/channel-feishu';
import { promptHidden } from './tty.ts';

const daemonMain = fileURLToPath(new URL('../../daemon/src/main.ts', import.meta.url));

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) flags[key!] = inline;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) flags[key!] = argv[++i]!;
      else flags[key!] = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const flag = (args: Args, name: string): string | undefined =>
  typeof args.flags[name] === 'string' ? (args.flags[name] as string) : undefined;

async function withIpc<T>(fn: (client: IpcClient) => Promise<T>): Promise<T | undefined> {
  try {
    const client = await IpcClient.connect(paths.socket());
    try {
      return await fn(client);
    } finally {
      client.close();
    }
  } catch {
    return undefined;
  }
}

const print = (line = ''): void => {
  process.stdout.write(line + '\n');
};
const ok = (line: string): void => print(`✓ ${line}`);
const fail = (line: string): void => print(`✗ ${line}`);

/* -------------------------------- connect -------------------------------- */

async function cmdConnect(args: Args): Promise<number> {
  const appId = args.positional[1];
  if (!appId) {
    print('用法: lark-echo connect <app_id>');
    return 1;
  }
  const domain = (flag(args, 'domain') ?? 'feishu') as 'feishu' | 'lark';
  const secret = process.env.LARK_ECHO_APP_SECRET ?? (await promptHidden('App Secret: '));
  if (!secret) {
    fail('未输入 secret');
    return 1;
  }
  print('正在校验凭据…');
  const result = await verifyCredentials(appId, secret, domain);
  if (!result.ok) {
    fail(`凭据校验失败: ${result.error}`);
    return 1;
  }
  ensureHome();
  saveCredential(appId, secret);
  ok(`凭据校验通过，已存入 ${paths.credential(appId)} (0600)`);
  print(`  bot open_id: ${result.botOpenId}`);
  if (result.appName) print(`  应用名称: ${result.appName}`);
  print('');
  print('下一步:');
  print('  1. 把机器人拉进目标群');
  print('  2. lark-echo daemon start');
  print('  3. lark-echo bind --owner <你的 open_id>   # 或在群里 @机器人 一次，从 lark-echo logs 里找到 open_id');
  return 0;
}

async function cmdRevoke(args: Args): Promise<number> {
  const appId = args.positional[1];
  if (!appId) {
    print('用法: lark-echo revoke <app_id>');
    return 1;
  }
  ok(revokeCredential(appId) ? `已删除 ${appId} 的本机凭据` : `${appId} 没有本机凭据`);
  return 0;
}

/* --------------------------------- daemon -------------------------------- */

async function waitForSocket(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pong = await withIpc((c) => c.call('ping'));
    if (pong) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function cmdDaemon(args: Args): Promise<number> {
  const sub = args.positional[1] ?? 'status';
  if (sub === 'run') {
    await import(daemonMain);
    return 0;
  }
  if (sub === 'start') {
    if (await withIpc((c) => c.call('ping'))) {
      print('daemon 已在运行');
      return 0;
    }
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', daemonMain], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    if (await waitForSocket(15_000)) {
      ok(`daemon 已启动 (pid ${child.pid})`);
      print(`  日志: ${paths.logFile()}`);
      return 0;
    }
    fail(`daemon 启动失败，请查看日志: ${paths.logFile()}`);
    return 1;
  }
  if (sub === 'stop') {
    let pid: number | undefined;
    try {
      pid = Number(readFileSync(paths.pidFile(), 'utf8').trim());
    } catch {
      /* no pidfile */
    }
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    await withIpc((c) => c.call('shutdown').catch(() => undefined));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await withIpc((c) => c.call('ping')))) {
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      unlinkSync(paths.pidFile());
    } catch {
      /* ignore */
    }
    ok('daemon 已停止');
    return 0;
  }
  if (sub === 'status') {
    const pong = await withIpc((c) => c.call<{ pid: number }>('ping'));
    if (!pong) {
      print('daemon: 未运行');
      return 1;
    }
    const status = await withIpc((c) => c.call<Record<string, unknown>>('status'));
    ok(`daemon 运行中 (pid ${pong.pid})`);
    print(JSON.stringify(status, null, 2));
    return 0;
  }
  if (sub === 'logs') {
    const child = spawn('tail', ['-f', paths.logFile()], { stdio: 'inherit' });
    return await new Promise<number>((res) => child.on('exit', (code) => res(code ?? 0)));
  }
  print(`未知子命令: daemon ${sub}`);
  return 1;
}

/* --------------------------------- doctor -------------------------------- */

function printChecks(checks: DoctorCheck[]): void {
  for (const check of checks) {
    (check.ok ? ok : fail)(`${check.id}${check.detail ? ` — ${check.detail}` : ''}`);
    if (!check.ok && check.hint) print(`    → ${check.hint}`);
  }
}

async function cmdDoctor(args: Args): Promise<number> {
  const remote = await withIpc((c) => c.call<{ checks: DoctorCheck[] }>('doctor'));
  if (remote) {
    printChecks(remote.checks);
    return remote.checks.every((c) => c.ok) ? 0 : 1;
  }
  const appId = flag(args, 'app') ?? listCredentials()[0]?.appId;
  if (!appId) {
    fail('本机没有飞书凭据，先运行: lark-echo connect <app_id>');
    return 1;
  }
  const cred = loadCredential(appId);
  if (!cred) {
    fail(`凭据文件不存在: ${paths.credential(appId)}`);
    return 1;
  }
  const mode = (statSync(paths.credential(appId)).mode & 0o777).toString(8);
  (mode === '600' ? ok : fail)(`凭据文件权限 ${mode}（应为 600）`);
  const channel = new FeishuChannel({ appId: cred.appId, appSecret: cred.appSecret });
  const checks = await channel.doctor();
  printChecks(checks);
  return checks.every((c) => c.ok) ? 0 : 1;
}

/* ---------------------------------- bind --------------------------------- */

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

async function listChats(): Promise<{ chatId: string; name: string }[]> {
  const remote = await withIpc((c) => c.call<{ chatId: string; name: string }[]>('channel.chats'));
  if (remote) return remote;
  const appId = listCredentials()[0]?.appId;
  const cred = appId ? loadCredential(appId) : undefined;
  if (!cred) throw new Error('本机没有飞书凭据，先运行: lark-echo connect <app_id>');
  return new FeishuChannel({ appId: cred.appId, appSecret: cred.appSecret }).listChats();
}

async function cmdBind(args: Args): Promise<number> {
  const cwd = resolve(flag(args, 'cwd') ?? process.cwd());
  const sessionId = flag(args, 'session') ?? piSessionIdFor(cwd);
  if (!sessionId) {
    fail(`无法自动识别 pi 会话（cwd=${cwd}），请显式指定 --session <id>`);
    return 1;
  }
  const owner = flag(args, 'owner') ?? (args.flags.anyone ? '*' : undefined);
  if (!owner) {
    fail('必须指定 --owner <open_id>（或本地调试用 --anyone）');
    return 1;
  }

  const chats = await listChats();
  if (chats.length === 0) {
    fail('机器人不在任何群里，先把机器人拉进目标群');
    return 1;
  }
  let chatId = flag(args, 'chat');
  if (!chatId) {
    print('机器人所在的群：');
    chats.forEach((c, i) => print(`  ${i + 1}. ${c.name}  (${c.chatId})`));
    const answer = await promptHidden('选择序号: ');
    const idx = Number(answer) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= chats.length) {
      fail('无效的选择');
      return 1;
    }
    chatId = chats[idx]!.chatId;
  }

  const binding: Omit<Binding, 'createdAt'> & { createdAt?: number } = {
    chatId,
    sessionId,
    agent: 'pi',
    cwd,
    ownerOpenId: owner,
    mirrorMode: 'off',
  };
  const payload = { ...binding, createdAt: Date.now() };
  try {
    const created =
      (await withIpc((c) => c.call<Binding>('bind.add', payload))) ??
      insertBinding(openDb(), { ...payload, createdAt: Date.now() });
    ok(`已绑定 ${created.chatId} → session ${created.sessionId}`);
    print(`  agent: ${created.agent}  cwd: ${created.cwd}  owner: ${created.ownerOpenId}`);
    return 0;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function cmdUnbind(args: Args): Promise<number> {
  const chatId = args.positional[1] ?? flag(args, 'chat');
  if (!chatId) {
    print('用法: lark-echo unbind <chat_id>');
    return 1;
  }
  const res = await withIpc((c) => c.call<{ removed: boolean }>('bind.remove', { chatId }));
  const removed = res?.removed ?? deleteBinding(openDb(), chatId);
  ok(removed ? `已解绑 ${chatId}` : `${chatId} 没有绑定`);
  return 0;
}

/* ------------------------- 管理：绑定 / 镜像 / 模型 ------------------------- */

interface SessionRow {
  ref: { sessionId: string; agent: string; cwd: string };
  idleMs: number;
  model?: string;
}

async function cmdBindings(): Promise<number> {
  const bindings = (await withIpc((c) => c.call<Binding[]>('bind.list'))) ?? listBindings(openDb());
  if (bindings.length === 0) {
    print('没有绑定。用 lark-echo bind 创建一个。');
    return 0;
  }
  const sessions =
    (await withIpc((c) => c.call<SessionRow[]>('session.list'))) ?? ([] as SessionRow[]);
  const modelOf = new Map(sessions.map((s) => [s.ref.sessionId, s.model]));
  const rows = bindings.map((b) => ({
    chat: b.chatId,
    session: b.sessionId,
    agent: b.agent,
    mirror: b.mirrorMode,
    model: modelOf.get(b.sessionId) ?? '-',
    owner: b.ownerOpenId,
  }));
  const widths = {
    chat: Math.max(4, ...rows.map((r) => r.chat.length)),
    session: Math.max(7, ...rows.map((r) => r.session.length)),
    model: Math.max(5, ...rows.map((r) => r.model.length)),
  };
  print(
    `${'CHAT'.padEnd(widths.chat)}  ${'SESSION'.padEnd(widths.session)}  AGENT  ${'MIRROR'.padEnd(14)}  ${'MODEL'.padEnd(widths.model)}  OWNER`,
  );
  for (const r of rows) {
    print(
      `${r.chat.padEnd(widths.chat)}  ${r.session.padEnd(widths.session)}  ${r.agent.padEnd(5)}  ${r.mirror.padEnd(14)}  ${r.model.padEnd(widths.model)}  ${r.owner}`,
    );
  }
  return 0;
}

const MIRROR_MODES = ['off', 'user', 'user+assistant', 'full'];

async function cmdMirror(args: Args): Promise<number> {
  const chatId = args.positional[1];
  const mode = args.positional[2];
  if (!chatId || !mode || !MIRROR_MODES.includes(mode)) {
    print(`用法: lark-echo mirror <chat_id> <${MIRROR_MODES.join('|')}>`);
    return 1;
  }
  const res = await withIpc((c) => c.call<{ updated: boolean }>('mirror.set', { chatId, mode }));
  const updated = res?.updated ?? setMirrorMode(openDb(), chatId, mode as never);
  ok(updated ? `${chatId} mirror = ${mode}` : `${chatId} 没有绑定`);
  return updated ? 0 : 1;
}

async function cmdModel(args: Args): Promise<number> {
  const sessionId = args.positional[1];
  const model = args.positional[2];
  if (!sessionId) {
    print('用法: lark-echo model <session_id> [<provider>/<model>]');
    return 1;
  }
  if (!model) {
    const current = getSessionModel(openDb(), sessionId);
    print(`${sessionId}: ${current ?? '(agent 默认模型)'}`);
    return 0;
  }
  const res = await withIpc((c) =>
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

async function cmdModels(args: Args): Promise<number> {
  const sessionId = args.positional[1];
  if (!sessionId) {
    print('用法: lark-echo models <session_id>');
    return 1;
  }
  const res = await withIpc((c) =>
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

async function cmdSessions(args: Args): Promise<number> {
  const release = flag(args, 'release');
  if (release) {
    await withIpc((c) => c.call('session.release', { sessionId: release }));
    ok(`已释放 ${release}`);
    return 0;
  }
  const sessions = await withIpc((c) => c.call<SessionRow[]>('session.list'));
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

/* --------------------------------- chats --------------------------------- */

async function cmdChats(): Promise<number> {
  try {
    const chats = await listChats();
    if (chats.length === 0) {
      print('机器人不在任何群里，先把它拉进目标群');
      return 1;
    }
    for (const c of chats) print(`${c.chatId}  ${c.name}`);
    return 0;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/* --------------------------------- status -------------------------------- */

async function cmdStatus(): Promise<number> {
  const bindings = (await withIpc((c) => c.call<Binding[]>('bind.list'))) ?? listBindings(openDb());
  const pong = await withIpc((c) => c.call<{ pid: number }>('ping'));
  print(`daemon: ${pong ? `运行中 (pid ${pong.pid})` : '未运行'}`);
  if (bindings.length === 0) {
    print('绑定: 无');
    return 0;
  }
  print('绑定:');
  for (const b of bindings) {
    print(`  ${b.chatId} → ${b.sessionId}  [${b.agent}] owner=${b.ownerOpenId} mirror=${b.mirrorMode}`);
  }
  return 0;
}

/* ---------------------------------- help --------------------------------- */

function usage(): void {
  print(`lark-echo — 把飞书群聊接到本地 agent 会话

用法:
  lark-echo connect <app_id>              录入 app secret（TTY 静默输入，唯一入口）
  lark-echo revoke <app_id>               删除本机凭据
  lark-echo daemon run|start|stop|status|logs
  lark-echo doctor [--app <app_id>]       体检：凭据 / 权限 / 长连接
  lark-echo chats                         列出机器人所在的群
  lark-echo bind [--session <id>] [--cwd <dir>] [--owner <open_id>|--anyone] [--chat <chat_id>]
  lark-echo unbind <chat_id>
  lark-echo bindings                      绑定总览（含模型与镜像档位）
  lark-echo mirror <chat_id> <off|user|user+assistant|full>
  lark-echo model <session_id> [<provider>/<model>]  查看/设置模型
  lark-echo models <session_id>           列出可切换的模型（需会话在运行）
  lark-echo sessions [--release <session_id>]
  lark-echo status

环境变量:
  LARK_ECHO_APP_SECRET   自动化场景替代交互输入
  LARK_ECHO_APP_ID       daemon 使用哪个应用（默认取本机唯一凭据）
  LARK_ECHO_HOME         状态目录，默认 ~/.lark-echo`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args.positional[0];
  switch (cmd) {
    case 'connect':
      return cmdConnect(args);
    case 'revoke':
      return cmdRevoke(args);
    case 'daemon':
      return cmdDaemon(args);
    case 'doctor':
      return cmdDoctor(args);
    case 'bind':
      return cmdBind(args);
    case 'unbind':
      return cmdUnbind(args);
    case 'chats':
      return cmdChats();
    case 'bindings':
      return cmdBindings();
    case 'mirror':
      return cmdMirror(args);
    case 'model':
      return cmdModel(args);
    case 'models':
      return cmdModels(args);
    case 'sessions':
      return cmdSessions(args);
    case 'status':
      return cmdStatus();
    case undefined:
    case 'help':
    case '--help':
      usage();
      return 0;
    default:
      fail(`未知命令: ${cmd}`);
      usage();
      return 1;
  }
}

void main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
