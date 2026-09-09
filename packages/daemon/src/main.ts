import { createWriteStream, writeFileSync, unlinkSync } from 'node:fs';
import {
  createLogger,
  ensureHome,
  listCredentials,
  loadCredential,
  openDb,
  paths,
  setLogSink,
} from '@lark-echo/core';
import { PiAdapter } from '@lark-echo/adapter-pi';
import { ClaudeAdapter } from '@lark-echo/adapter-claude';
import { CodexAdapter } from '@lark-echo/adapter-codex';
import { FeishuChannel } from '@lark-echo/channel-feishu';
import { Daemon } from './server.ts';

/**
 * daemon 入口：`lark-echo daemon run`（前台）或 `daemon start`（后台，输出重定向到日志）。
 */
export async function runDaemon(): Promise<void> {
  ensureHome();
  const logger = createLogger({ svc: 'daemon' });
  const logStream = createWriteStream(paths.logFile(), { flags: 'a' });
  setLogSink((line) => {
    process.stderr.write(line + '\n');
    logStream.write(line + '\n');
  });

  const appId = process.env.LARK_ECHO_APP_ID ?? listCredentials()[0]?.appId;
  if (!appId) {
    logger.error('no feishu app configured; run: lark-echo connect <app_id>');
    process.exit(1);
  }
  const cred = loadCredential(appId);
  if (!cred) {
    logger.error('credential file missing or unreadable', { appId });
    process.exit(1);
  }

  const db = openDb();
  // 防御：清掉陈旧 socket（上次异常退出时可能没 unlink）
  try {
    unlinkSync(paths.socket());
  } catch {
    /* 不存在即可 */
  }
  const channel = new FeishuChannel({
    appId: cred.appId,
    appSecret: cred.appSecret,
    logger,
  });
  const daemon = new Daemon({
    db,
    channel,
    adapters: {
      pi: new PiAdapter({ logger }),
      claude: new ClaudeAdapter({ logger }),
      codex: new CodexAdapter({ logger }),
    },
    logger,
  });

  await daemon.start();
  writeFileSync(paths.pidFile(), String(process.pid));
  logger.info('daemon ready', { pid: process.pid, appId });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runDaemon().catch((err: unknown) => {
    process.stderr.write(`daemon failed: ${String(err)}\n`);
    process.exit(1);
  });
}
