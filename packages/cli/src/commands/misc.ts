import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ensureHome, listBindings, openDb, paths, writeSecretFile, type Binding } from '@instead/core';
import { bool, flag, type Args } from '../args.ts';
import { fail, ok, print } from '../io.ts';
import { pingDaemon, withDaemon } from '../daemon-client.ts';
import { listChats } from '../chats.ts';
import { planHost, tailscaleInfo } from '../ui-host.ts';

export async function cmdChats(): Promise<number> {
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

export async function cmdUi(args: Args): Promise<number> {
  if (bool(args, 'stop')) {
    const res = await withDaemon((c) => c.call('ui.stop'));
    if (res === undefined) {
      fail('daemon 未运行，配置台本来就没开');
      return 1;
    }
    ok('配置台已关闭');
    return 0;
  }

  const { host, allowHosts } = planHost(flag(args, 'host'), tailscaleInfo());
  const auth = bool(args, 'auth');
  const token = auth ? randomBytes(24).toString('hex') : undefined;
  ensureHome();
  if (token) writeSecretFile(paths.uiToken(), token);

  const portFlag = flag(args, 'port');
  const port = portFlag ? Number(portFlag) : 0;
  if (portFlag && !Number.isInteger(port)) {
    fail(`--port 需要是整数，收到 ${portFlag}`);
    return 1;
  }

  const res = await withDaemon((c) =>
    c.call<{ url: string }>('ui.start', {
      ...(token ? { token } : {}),
      host,
      allowHosts,
      port,
    }),
  );
  if (!res) {
    fail('daemon 未运行，先执行 instead daemon start');
    return 1;
  }
  ok(`配置台已启动: ${res.url}`);
  print(
    `  监听 ${host} · ${auth ? '需要 token' : '无鉴权（加 --auth 可开）'} · instead ui --stop 关闭`,
  );
  if (!bool(args, 'no-open')) {
    spawn('xdg-open', [res.url], { stdio: 'ignore', detached: true }).unref();
  }
  return 0;
}

export async function cmdStatus(): Promise<number> {
  const pong = await pingDaemon();
  print(`daemon: ${pong ? `运行中 (pid ${pong.pid})` : '未运行'}`);
  const bindings = (await withDaemon((c) => c.call<Binding[]>('bind.list'))) ?? listBindings(openDb());
  if (bindings.length === 0) {
    print('绑定: 无');
    return 0;
  }
  print('绑定:');
  for (const b of bindings) {
    print(
      `  ${b.chatId} → ${b.sessionId}  [${b.agent}] owner=${b.ownerOpenId} mirror=${b.mirrorMode}`,
    );
  }
  return 0;
}
