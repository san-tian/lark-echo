import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAdapter } from '../src/adapter.ts';
import { buildPrompt } from '../src/adapter.ts';

const withSessionDir = () => mkdtempSync(join(tmpdir(), 'anylark-pi-'));

/** 契约测试需要真实的 pi CLI；没有就跳过（CI 友好） */
const hasPi = ((): boolean => {
  try {
    execFileSync('pi', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('buildPrompt 把上下文放在真实消息之前', () => {
  const text = buildPrompt({
    text: '[张三 · 飞书] 看看',
    context: [
      { kind: 'pending-window', conversationKey: 'feishu:chat:oc_a', text: '<pending>旧消息</pending>' },
    ],
  });
  assert.match(text, /^<pending>旧消息<\/pending>\n\n\[张三 · 飞书\] 看看$/);
});

test('契约：起真实 pi 进程，发一条消息拿到最终文本', { skip: !hasPi, timeout: 120_000 }, async () => {
  const adapter = new PiAdapter({ sessionDir: withSessionDir(), isolateExtensions: true });
  const handle = await adapter.start({ cwd: process.cwd(), sessionId: 'contract-001' });
  assert.equal(handle.ref.agent, 'pi');
  assert.equal(handle.ref.sessionId, 'contract-001');

  const turn = await adapter.send(handle, { text: 'Reply with exactly: OK' });
  const deltas: string[] = [];
  turn.onEvent((e) => {
    if (e.type === 'delta' && e.text) deltas.push(e.text);
  });
  const result = await turn.settled;
  assert.equal(result.aborted, false);
  assert.equal(result.error, undefined);
  assert.match(result.text, /OK/);
  assert.ok(deltas.join('').includes('OK'), '应收到流式 delta');

  await adapter.stop(handle);
});

test('契约：session 可续跑（同一 sessionId 再次 start 能看到历史）', { skip: !hasPi, timeout: 120_000 }, async () => {
  const dir = withSessionDir();
  const adapter1 = new PiAdapter({ sessionDir: dir, isolateExtensions: true });
  const h1 = await adapter1.start({ cwd: process.cwd(), sessionId: 'contract-002' });
  await (await adapter1.send(h1, { text: 'Reply with exactly: ONE' })).settled;
  await adapter1.stop(h1);

  const adapter2 = new PiAdapter({ sessionDir: dir, isolateExtensions: true });
  const h2 = await adapter2.start({ cwd: process.cwd(), sessionId: 'contract-002' });
  const entries: string[] = [];
  for await (const e of adapter2.history(h2)) entries.push(`${e.role}:${e.text}`);
  assert.ok(entries.some((e) => e.includes('ONE')), `续跑应能看到历史，实际：${entries.join('|')}`);
  await adapter2.stop(h2);
});
