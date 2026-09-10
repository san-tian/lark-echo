/**
 * 命令行参数解析。纯函数、无副作用 —— 单独一个模块是为了可测试
 * （`index.ts` 顶层会执行 main()，import 它就等于跑一次 CLI）。
 */

export interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

/**
 * 支持 `--key value`、`--key=value`、`--key`（布尔）三种形态。
 * `--` 之后的一律当位置参数，不再解析成 flag。
 */
export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (rest) {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      rest = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        // 只在第一个 = 上切，值里含 = 也能原样保留
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) {
        flags[body] = argv[++i]!;
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** 取字符串型 flag；布尔 flag（`--foo` 无值）返回 undefined */
export const flag = (args: Args, name: string): string | undefined =>
  typeof args.flags[name] === 'string' ? (args.flags[name] as string) : undefined;

/** 取布尔型 flag：`--foo` 或 `--foo=true` 都算真 */
export const bool = (args: Args, name: string): boolean => {
  const v = args.flags[name];
  return v === true || v === 'true';
};
