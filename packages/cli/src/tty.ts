import { createInterface } from 'node:readline';

/**
 * 普通可见输入（选序号、填名字这类）。
 * 别拿 promptHidden 干这个 —— 那个是给 secret 用的，会屏蔽回显，
 * 用户看不见自己输入了什么。
 */
export function promptVisible(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error('需要交互式终端；非交互场景请用命令行参数显式指定'));
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** TTY 静默输入：不回显、不进 argv、不进 shell history（DESIGN §8.1） */
export function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(
      new Error('需要交互式终端；CI 场景请改用环境变量 INSTEAD_APP_SECRET'),
    );
  }
  process.stdout.write(question);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // 屏蔽回显
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}
