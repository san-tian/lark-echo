import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 所有状态都落在 ~/.anylark/ 下（可用 ANYLARK_HOME 覆盖，测试用）。
 * 注意：会话 transcript 不在这里 —— 它归各 agent 自己管（DESIGN §3）。
 *
 * 改名自 lark-echo：`LARK_ECHO_HOME` 仍作为兼容读取，`~/.lark-echo/` 由
 * ensureHome() 一次性搬到 `~/.anylark/`。
 */
const LEGACY_HOME = () => join(homedir(), '.lark-echo');

export const anylarkHome = (): string =>
  process.env.ANYLARK_HOME ?? process.env.LARK_ECHO_HOME ?? join(homedir(), '.anylark');

export const paths = {
  home: () => anylarkHome(),
  stateDb: () => join(anylarkHome(), 'state.db'),
  credentialsDir: () => join(anylarkHome(), 'feishu'),
  credential: (appId: string) => join(anylarkHome(), 'feishu', `${appId}.json`),
  socket: () => join(anylarkHome(), 'daemon.sock'),
  pidFile: () => join(anylarkHome(), 'daemon.pid'),
  logFile: () => join(anylarkHome(), 'daemon.log'),
  uiToken: () => join(anylarkHome(), 'ui-token'),
  inbox: (msgId: string) => join(anylarkHome(), 'feishu-inbox', msgId),
};

/**
 * 内部：执行目录迁移的纯函数，可测试。
 * @returns true 迁移成功, false 无需迁移或失败
 */
export function _migrateDir(legacy: string, target: string): boolean {
  if (existsSync(target) || !existsSync(legacy)) return false;
  try {
    renameSync(legacy, target);
    return true;
  } catch {
    return false; // 跨设备等罕见情况
  }
}

/**
 * 一次性把 `~/.lark-echo/` 搬成 `~/.anylark/`（改名迁移）。
 * 幂等：新目录已存在、或旧目录不存在时都直接返回 false。
 * 只在两者都是默认路径时做 —— 显式设了 *_HOME 就完全听环境变量的。
 */
export function migrateLegacyHome(): boolean {
  if (process.env.ANYLARK_HOME ?? process.env.LARK_ECHO_HOME) return false;
  const legacy = LEGACY_HOME();
  const home = join(homedir(), '.anylark');
  return _migrateDir(legacy, home);
}

/** 创建 ~/.anylark 并强制 0700（顺带做一次改名迁移） */
export function ensureHome(): string {
  migrateLegacyHome();
  const home = anylarkHome();
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
