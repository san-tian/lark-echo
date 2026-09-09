import { execFileSync } from 'node:child_process';

/**
 * codex 不在非登录 shell 的默认 PATH 上（本机实测），兜底到 nvm 下的绝对路径。
 * 见 docs/spikes/05-codex-adapter.md §1。
 */
export const CODEX_FALLBACK_COMMAND = '/home/dev/.nvm/versions/node/v24.14.0/bin/codex';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface TurnArgsOptions {
  /** 续跑既有 thread；缺省表示新建 */
  resumeId?: string;
  model?: string;
  /** 不传则沿用 codex 自己的 config.toml */
  sandboxMode?: SandboxMode;
  extraArgs?: string[];
  /** 默认 true：daemon 的 cwd 不一定是 git repo */
  skipGitRepoCheck?: boolean;
  imagePaths?: string[];
  /** `-o` 权威最终文本落盘位置 */
  outputLastMessagePath: string;
}

/** `which codex` → CODEX_BIN → 已知绝对路径（任务要求：探测 + 兜底 + 可配置） */
export function resolveCodexCommand(configured?: string): string {
  const explicit = configured?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.CODEX_BIN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const found = execFileSync('which', ['codex'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (found) return found;
  } catch {
    /* codex 不在 PATH 上 */
  }
  return CODEX_FALLBACK_COMMAND;
}

/**
 * 组装一轮 turn 的 argv。
 *
 * - prompt 永远走 stdin（末尾 `-`）：群消息可能含 secret，不能进 argv（DESIGN §11.9）。
 * - `-c approval_policy="never"`：headless 下没有 TTY，弹审批就是挂死（spike §1.4）。
 * - `resume` 子命令没有 `-s`，沙箱只能走 `-c sandbox_mode=...`（spike §1.3）。
 */
export function buildTurnArgs(opts: TurnArgsOptions): string[] {
  const resumeId = opts.resumeId;
  const args = ['exec'];
  if (resumeId) args.push('resume');
  args.push('--json');
  if (opts.skipGitRepoCheck ?? true) args.push('--skip-git-repo-check');
  if (opts.sandboxMode) {
    if (resumeId) args.push('-c', `sandbox_mode=${JSON.stringify(opts.sandboxMode)}`);
    else args.push('-s', opts.sandboxMode);
  }
  args.push('-c', 'approval_policy="never"');
  if (opts.model) {
    // 支持 `provider/model`：切 provider（否则 codex 只会用 config.toml 里的 model_provider）
    const slash = opts.model.indexOf('/');
    if (slash > 0) {
      const provider = opts.model.slice(0, slash);
      const modelId = opts.model.slice(slash + 1);
      args.push('-c', `model_provider=${JSON.stringify(provider)}`);
      args.push('-m', modelId);
    } else {
      args.push('-m', opts.model);
    }
  }
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  args.push('-o', opts.outputLastMessagePath);

  const images = opts.imagePaths ?? [];
  if (resumeId) {
    // resume 的 -i 只吃单值，需要重复
    for (const image of images) args.push('-i', image);
  } else if (images.length > 0) {
    // exec 的 -i 是多值，放在 -- 之前
    args.push('-i', ...images);
  }

  args.push('--');
  if (resumeId) args.push(resumeId);
  args.push('-');
  return args;
}
