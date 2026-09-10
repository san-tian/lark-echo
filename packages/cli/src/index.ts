import { parseArgs } from './args.ts';
import { fail } from './io.ts';
import { cmdConnect, cmdDoctor, cmdRevoke } from './commands/connect.ts';
import { cmdDaemon } from './commands/daemon.ts';
import { cmdBind, cmdBindings, cmdMirror, cmdUnbind } from './commands/bind.ts';
import { cmdModel, cmdModels, cmdSessions } from './commands/session.ts';
import { cmdChats, cmdStatus, cmdUi } from './commands/misc.ts';
import { usage } from './usage.ts';

/**
 * 跑一条命令，返回退出码。**不碰 process.exit** —— 那是 bin 入口的事，
 * 这样测试才能直接 import 并调用。
 */
export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
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
    case 'ui':
      return cmdUi(args);
    case 'status':
      return cmdStatus();
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      usage();
      return 0;
    default:
      fail(`未知命令: ${cmd}`);
      usage();
      return 1;
  }
}

/** bin 入口用：跑完就退，异常统一收口成退出码 1 */
export async function main(argv = process.argv.slice(2)): Promise<never> {
  let code = 1;
  try {
    code = await run(argv);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  process.exit(code);
}
