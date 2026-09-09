import { createInterface } from 'node:readline';

/** TTY 静默输入：不回显、不进 argv、不进 shell history（DESIGN §8.1） */
export function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(
      new Error('需要交互式终端；CI 场景请改用环境变量 LARK_ECHO_APP_SECRET'),
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
