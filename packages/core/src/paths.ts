import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 所有状态都落在 ~/.lark-echo/ 下（可用 LARK_ECHO_HOME 覆盖，测试用）。
 * 注意：会话 transcript 不在这里 —— 它归各 agent 自己管（DESIGN §3）。
 */
export const larkEchoHome = (): string =>
  process.env.LARK_ECHO_HOME ?? join(homedir(), '.lark-echo');

export const paths = {
  home: () => larkEchoHome(),
  stateDb: () => join(larkEchoHome(), 'state.db'),
  credentialsDir: () => join(larkEchoHome(), 'feishu'),
  credential: (appId: string) => join(larkEchoHome(), 'feishu', `${appId}.json`),
  socket: () => join(larkEchoHome(), 'daemon.sock'),
  pidFile: () => join(larkEchoHome(), 'daemon.pid'),
  logFile: () => join(larkEchoHome(), 'daemon.log'),
  uiToken: () => join(larkEchoHome(), 'ui-token'),
  inbox: (msgId: string) => join(larkEchoHome(), 'feishu-inbox', msgId),
};

/** 创建 ~/.lark-echo 并强制 0700 */
export function ensureHome(): string {
  const home = larkEchoHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    chmodSync(home, 0o700);
  } catch {
    /* 非 POSIX 或权限不足时忽略 */
  }
  return home;
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** 写入敏感文件：强制 0600（§8.1 凭据） */
export function writeSecretFile(file: string, contents: string): void {
  ensureDir(dirname(file));
  try {
    unlinkSync(file);
  } catch {
    /* 不存在即可 */
  }
  writeFileSync(file, contents, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
}
