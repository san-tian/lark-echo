import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { paths } from '@anylark/core';
import type { Args } from '../args.ts';
import { fail, ok, print } from '../io.ts';
import { pingDaemon, waitForDaemon, waitForDaemonGone, withDaemon } from '../daemon-client.ts';

const daemonMain = fileURLToPath(new URL('../../../daemon/src/main.ts', import.meta.url));

function readPid(): number | undefined {
  try {
    const pid = Number(readFileSync(paths.pidFile(), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function start(): Promise<number> {
  if (await pingDaemon()) {
    print('daemon 已在运行');
    return 0;
  }
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', daemonMain], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  if (await waitForDaemon(15_000)) {
    ok(`daemon 已启动 (pid ${child.pid})`);
    print(`  日志: ${paths.logFile()}`);
    return 0;
  }
  fail(`daemon 启动失败，请查看日志: ${paths.logFile()}`);
  return 1;
}

async function stop(): Promise<number> {
  const wasRunning = Boolean(await pingDaemon());
  const pid = readPid();
  if (!wasRunning && !pid) {
    print('daemon 未运行');
    return 0;
  }

  // 先请它自己收尾，再兜底发信号。shutdown 期间连接被切断是正常的，不算错。
  try {
    await withDaemon((c) => c.call('shutdown'));
  } catch {
    /* 连接在响应前就断了 —— 正是我们要的结果 */
  }
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已经没了 */
    }
  }

  const gone = await waitForDaemonGone(10_000);
  if (!gone) {
    fail('daemon 在 10s 内没有退出，可能卡住了；必要时 kill -9');
    return 1;
  }
  try {
    unlinkSync(paths.pidFile());
  } catch {
    /* daemon 自己清掉了 */
  }
  ok('daemon 已停止');
  return 0;
}

async function status(): Promise<number> {
  const pong = await pingDaemon();
  if (!pong) {
    print('daemon: 未运行');
    return 1;
  }
  const detail = await withDaemon((c) => c.call<Record<string, unknown>>('status'));
  ok(`daemon 运行中 (pid ${pong.pid})`);
  print(JSON.stringify(detail, null, 2));
  return 0;
}

export async function cmdDaemon(args: Args): Promise<number> {
  const sub = args.positional[1] ?? 'status';
  switch (sub) {
    case 'run':
      await import(daemonMain);
      return 0;
    case 'start':
      return start();
    case 'stop':
      return stop();
    case 'status':
      return status();
    case 'logs': {
      const child = spawn('tail', ['-f', paths.logFile()], { stdio: 'inherit' });
      return await new Promise<number>((res) => child.on('exit', (code) => res(code ?? 0)));
    }
    default:
      fail(`未知子命令: daemon ${sub}`);
      print('可用: run | start | stop | status | logs');
      return 1;
  }
}
