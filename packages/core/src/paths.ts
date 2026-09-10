import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 所有状态都落在 ~/.instead/ 下（可用 INSTEAD_HOME 覆盖，测试用）。
 * 注意：会话 transcript 不在这里 —— 它归各 agent 自己管（DESIGN §3）。
 *
 * 改过两次名：`lark-echo` → `anylark` → `instead`（DESIGN §1.3.1）。
 * 两个旧名的环境变量仍兼容读取，旧目录由 ensureHome() 一次性搬过来。
 */
const DEFAULT_DIR = '.instead';

/** 旧状态目录，**按新到旧排列** —— 迁移时取第一个存在的 */
const LEGACY_DIRS = ['.anylark', '.lark-echo'];

/** 旧环境变量，按新到旧排列 */
const LEGACY_ENV = ['ANYLARK_HOME', 'LARK_ECHO_HOME'];

const envHome = (): string | undefined => {
  if (process.env.INSTEAD_HOME) return process.env.INSTEAD_HOME;
  for (const key of LEGACY_ENV) {
    if (process.env[key]) return process.env[key];
  }
  return undefined;
};

export const insteadHome = (): string => envHome() ?? join(homedir(), DEFAULT_DIR);

export const paths = {
  home: () => insteadHome(),
  stateDb: () => join(insteadHome(), 'state.db'),
  credentialsDir: () => join(insteadHome(), 'feishu'),
  credential: (appId: string) => join(insteadHome(), 'feishu', `${appId}.json`),
  socket: () => join(insteadHome(), 'daemon.sock'),
  pidFile: () => join(insteadHome(), 'daemon.pid'),
  logFile: () => join(insteadHome(), 'daemon.log'),
  uiToken: () => join(insteadHome(), 'ui-token'),
  /** 入站附件落盘位置（决策 23）：`~/.instead/media/<chatId>/` */
  mediaDir: () => join(insteadHome(), 'media'),
  inbox: (msgId: string) => join(insteadHome(), 'feishu-inbox', msgId),
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
 * 一次性把旧状态目录搬成 `~/.instead/`（改名迁移）。
 * 幂等：新目录已存在、或没有任何旧目录时都直接返回 false。
 * 只在用默认路径时做 —— 显式设了 *_HOME 就完全听环境变量的。
 *
 * 改过两次名，所以按 `.anylark` → `.lark-echo` 的顺序找第一个存在的搬过来。
 * 取最新的那个：两个都在时 `.anylark` 才是有效状态，`.lark-echo` 是上一轮
 * 迁移留下的残留。
 */
export function migrateLegacyHome(): boolean {
  if (envHome()) return false;
  const home = join(homedir(), DEFAULT_DIR);
  for (const dir of LEGACY_DIRS) {
    if (_migrateDir(join(homedir(), dir), home)) return true;
  }
  return false;
}

/** 创建 ~/.instead 并强制 0700（顺带做一次改名迁移） */
export function ensureHome(): string {
  migrateLegacyHome();
  const home = insteadHome();
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
