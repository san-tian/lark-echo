import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TurnEvent, TurnResult } from '@instead/core';
import { CodexAdapter, buildPrompt } from '../src/adapter.ts';
import { buildTurnArgs, resolveCodexCommand } from '../src/codex-cli.ts';
import { codexItem, parseCodexLine, toolLabel } from '../src/events.ts';
import { findRolloutFile, readRolloutHistory } from '../src/rollout.ts';

const FAKE_THREAD_ID = '01a0f000-0000-7000-8000-000000000001';

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

/** 一个假 codex CLI：忽略真实参数，只回放固定的 --json 事件流（用于确定性测试解析/abort） */
function writeFakeCodex(dir: string, mode: 'ok' | 'hang' | 'fail'): string {
  const file = join(dir, `fake-codex-${mode}.mjs`);
  const script = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const outIndex = args.indexOf('-o');
const outFile = outIndex >= 0 ? args[outIndex + 1] : undefined;
const mode = ${JSON.stringify(mode)};
try { readFileSync(0, 'utf8'); } catch {}
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
emit({ type: 'thread.started', thread_id: ${JSON.stringify(FAKE_THREAD_ID)} });
emit({ type: 'turn.started' });
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'fail') {
  emit({ type: 'error', message: 'boom from fake' });
  emit({ type: 'turn.failed', error: { message: 'boom from fake' } });
  process.exit(1);
} else {
  emit({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: '/bin/echo hi' } });
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: '/bin/echo hi', exit_code: 0, status: 'completed' } });
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'FAKE OK' } });
  if (outFile) writeFileSync(outFile, 'FAKE OK');
  emit({ type: 'turn.completed', usage: {} });
}
`;
  writeFileSync(file, script, { mode: 0o755 });
  return file;
}

function waitForEvent(turn: { onEvent: (l: (e: TurnEvent) => void) => () => void }, type: TurnEvent['type']): Promise<void> {
  return new Promise((resolve) => {
    turn.onEvent((event) => {
      if (event.type === type) resolve();
    });
  });
}

// ------------------------------------------------------------------ pure units

test('buildTurnArgs：新会话走 stdin，不把 prompt 放 argv', () => {
  const args = buildTurnArgs({
    sandboxMode: 'read-only',
    outputLastMessagePath: '/tmp/out.txt',
  });
  assert.deepEqual(args.slice(0, 3), ['exec', '--json', '--skip-git-repo-check']);
  assert.ok(args.includes('-s') && args.includes('read-only'));
  assert.ok(args.includes('-c') && args.includes('approval_policy="never"'));
  assert.deepEqual(args.slice(-2), ['--', '-']);
  assert.ok(!args.some((arg) => arg.includes('Reply with exactly')));
});

test('buildTurnArgs：`provider/model` 切 provider，否则只当模型 id', () => {
  const args = buildTurnArgs({
    model: 'OpenAI/glm-5.2',
    sandboxMode: 'read-only',
    outputLastMessagePath: '/tmp/out.txt',
  });
  assert.ok(args.includes('model_provider="OpenAI"'));
  assert.ok(args.includes('-m') && args.includes('glm-5.2'));
  // 无斜杠时只是 -m
  const args2 = buildTurnArgs({ model: 'gpt-6-astra', outputLastMessagePath: '/tmp/out.txt' });
  assert.ok(args2.includes('-m') && args2.includes('gpt-6-astra'));
  assert.ok(!args2.some((a) => a.startsWith('model_provider=')));
});

test('buildTurnArgs：resume 没有 -s，沙箱用 -c sandbox_mode', () => {
  const args = buildTurnArgs({
    resumeId: '01a08678-a1b7-7532-99ed-94fd84e4dc6a',
    model: 'gpt-6-astra',
    sandboxMode: 'workspace-write',
    imagePaths: ['/tmp/a.png', '/tmp/b.png'],
    outputLastMessagePath: '/tmp/out.txt',
  });
  assert.deepEqual(args.slice(0, 2), ['exec', 'resume']);
  assert.ok(args.includes('-c') && args.includes('sandbox_mode="workspace-write"'));
  assert.ok(!args.includes('-s'));
  assert.deepEqual(args.slice(-2), ['01a08678-a1b7-7532-99ed-94fd84e4dc6a', '-']);
  // resume 的 -i 是单值，两个图片要有两个 -i
  assert.equal(args.filter((arg) => arg === '-i').length, 2);
});

test('buildPrompt：injectContext 的文本排在真实消息之前', () => {
  const text = buildPrompt(
    {
      text: '[张三 · 飞书] 看看',
      context: [
        { kind: 'pending-window', conversationKey: 'feishu:chat:oc_a', text: '<pending>旧消息</pending>' },
      ],
    },
    ['<historical>上回说到</historical>'],
  );
  assert.equal(
    text,
    '<historical>上回说到</historical>\n\n<pending>旧消息</pending>\n\n[张三 · 飞书] 看看',
  );
});

test('parseCodexLine / toolLabel 解析真实事件形状', () => {
  const event = parseCodexLine(
    '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \'ls\'","exit_code":0}}',
  );
  assert.equal(event?.type, 'item.completed');
  const item = event ? codexItem(event) : undefined;
  assert.ok(item);
  assert.equal(toolLabel(item), "/bin/bash -lc 'ls'");
  assert.equal(parseCodexLine('not json'), undefined);
  assert.equal(parseCodexLine(''), undefined);
  assert.equal(parseCodexLine('{"no":"type"}'), undefined);
});

// ------------------------------------------------------------------ rollout history

test('rollout：按 thread id 找文件并用 ordinal 作游标', async () => {
  const dir = tempDir('instead-codex-rollout-');
  const day = join(dir, '2026', '09', '09');
  mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-2026-09-09T14-02-28-${FAKE_THREAD_ID}.jsonl`);
  const lines = [
    { timestamp: '2026-09-09T14:02:28.677Z', ordinal: 0, type: 'session_meta', payload: { session_id: FAKE_THREAD_ID } },
    {
      timestamp: '2026-09-09T14:02:28.918Z',
      ordinal: 1,
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'hi' }] } },
    },
    {
      timestamp: '2026-09-09T14:02:33.633Z',
      ordinal: 2,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'hello' }], phase: 'final_answer' },
      },
    },
    {
      timestamp: '2026-09-09T14:02:33.700Z',
      ordinal: 3,
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'c1', command: ['/bin/bash', '-lc', 'ls'] } },
    },
  ];
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

  assert.equal(findRolloutFile(dir, FAKE_THREAD_ID), file);
  assert.equal(findRolloutFile(dir, 'missing-thread'), undefined);

  const all: string[] = [];
  for await (const entry of readRolloutHistory(file)) all.push(`${entry.role}:${entry.text}`);
  assert.deepEqual(all, ['user:hi', 'assistant:hello', 'other:/bin/bash -lc ls']);

  // cursor 必须能直接用上一条 entry.id 回传
  const first: string[] = [];
  for await (const entry of readRolloutHistory(file)) {
    first.push(entry.id);
    break;
  }
  const since: string[] = [];
  for await (const entry of readRolloutHistory(file, first[0])) since.push(entry.text);
  assert.deepEqual(since, ['hello', '/bin/bash -lc ls']);
});

// ------------------------------------------------------------------ fake CLI contract

test('契约：解析 codex --json 事件流并落到 final', { timeout: 30_000 }, async () => {
  const dir = tempDir('instead-codex-fake-ok-');
  const adapter = new CodexAdapter({
    command: writeFakeCodex(dir, 'ok'),
    sessionsDir: join(dir, 'sessions'),
    sandboxMode: 'read-only',
  });
  const handle = await adapter.start({ cwd: dir });
  assert.equal(handle.ref.agent, 'codex');
  assert.deepEqual(handle.capabilities, {
    persistent: false,
    steer: false,
    liveAttach: 'lease',
    approvals: false,
    modelSwitch: 'restart',
    // codex 自己生成 thread id（ULID），只能拿学到的 id resume
    sessionIdSemantics: 'opaque',
  });

  const events: TurnEvent[] = [];
  const turn = await adapter.send(handle, { text: 'hello' });
  turn.onEvent((event) => events.push(event));
  const result = await turn.settled;

  assert.equal(result.aborted, false);
  assert.equal(result.error, undefined);
  assert.equal(result.text, 'FAKE OK');
  assert.ok(events.some((event) => event.type === 'started'), '应收到 started');
  assert.ok(
    events.some((event) => event.type === 'delta' && event.text === 'FAKE OK'),
    '应收到 delta',
  );
  assert.ok(events.some((event) => event.type === 'tool' && /echo hi/.test(event.text ?? '')), '应收到 tool');
  assert.ok(events.some((event) => event.type === 'final' && event.text === 'FAKE OK'), '应收到 final');
  // 新会话在首轮 thread.started 后把占位 id 换成真实 thread id
  assert.equal(handle.ref.sessionId, FAKE_THREAD_ID);

  await adapter.stop(handle);
});

test('契约：abort() 终止子进程并结算 aborted', { timeout: 30_000 }, async () => {
  const dir = tempDir('instead-codex-fake-hang-');
  const adapter = new CodexAdapter({ command: writeFakeCodex(dir, 'hang'), sessionsDir: join(dir, 'sessions') });
  const handle = await adapter.start({ cwd: dir });
  const turn = await adapter.send(handle, { text: 'hang please' });
  await waitForEvent(turn, 'started');

  await adapter.abort(handle, turn.turnId);
  const result = await turn.settled;
  assert.equal(result.aborted, true);
  await adapter.stop(handle);
});

test('契约：codex 报错时结算 error 并发 error 事件', { timeout: 30_000 }, async () => {
  const dir = tempDir('instead-codex-fake-fail-');
  const adapter = new CodexAdapter({ command: writeFakeCodex(dir, 'fail'), sessionsDir: join(dir, 'sessions') });
  const handle = await adapter.start({ cwd: dir });
  const events: TurnEvent[] = [];
  const turn = await adapter.send(handle, { text: 'fail please' });
  turn.onEvent((event) => events.push(event));
  const result = await turn.settled;

  assert.equal(result.aborted, false);
  assert.match(result.error ?? '', /boom from fake/);
  assert.ok(events.some((event) => event.type === 'error' && /boom from fake/.test(event.text ?? '')));
  await adapter.stop(handle);
});

// ------------------------------------------------------------------ real codex

const codexCommand = resolveCodexCommand();
const hasCodex = ((): boolean => {
  try {
    execFileSync(codexCommand, ['--version'], { stdio: 'ignore' });
    execFileSync(codexCommand, ['login', 'status'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** 实测 provider 会断流（codex 自报 Reconnecting 1/5…），这是环境抖动，不是 adapter bug */
const TRANSIENT_PROVIDER = /stream disconnected|Reconnecting|socket hang up|ECONNRESET/i;

async function runTurnWithRetry(
  adapter: CodexAdapter,
  handle: Parameters<CodexAdapter['send']>[0],
  text: string,
  attempts = 4,
): Promise<{ result: TurnResult; deltas: string[] }> {
  const deltas: string[] = [];
  let result: TurnResult = { text: '', aborted: false, error: 'no attempt' };
  for (let attempt = 0; attempt < attempts; attempt++) {
    deltas.length = 0;
    const turn = await adapter.send(handle, { text });
    turn.onEvent((event) => {
      if (event.type === 'delta' && event.text) deltas.push(event.text);
    });
    result = await turn.settled;
    if (!result.error || !TRANSIENT_PROVIDER.test(result.error)) break;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return { result, deltas };
}

test('契约：真实 codex 起一轮，最终文本含 OK，且 rollout 可读', { skip: !hasCodex, timeout: 300_000 }, async (t) => {
  const cwd = tempDir('instead-codex-real-');
  const adapter = new CodexAdapter({
    command: codexCommand,
    sandboxMode: 'read-only',
    turnTimeoutMs: 60_000,
  });
  const handle = await adapter.start({ cwd });
  const { result, deltas } = await runTurnWithRetry(adapter, handle, 'Reply with exactly: OK');

  assert.equal(result.aborted, false, `真实 turn 不应被 abort：${result.error ?? ''}`);
  if (result.error && TRANSIENT_PROVIDER.test(result.error)) {
    await adapter.stop(handle);
    t.skip(`provider 连续断流，环境不可用：${result.error}`);
    return;
  }
  assert.equal(result.error, undefined);
  assert.match(result.text, /OK/);
  assert.ok(deltas.join('').includes('OK'), '应收到 delta');
  assert.match(handle.ref.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const history: string[] = [];
  for await (const entry of adapter.history(handle)) history.push(`${entry.role}:${entry.text}`);
  assert.ok(history.some((entry) => entry.startsWith('user:') && entry.includes('Reply with exactly: OK')));
  assert.ok(history.some((entry) => entry.startsWith('assistant:') && entry.includes('OK')));

  await adapter.stop(handle);
});

test('契约：resume 既有 thread 能记得上一轮', { skip: !hasCodex, timeout: 420_000 }, async (t) => {
  // 自包含：先造一条 thread，再用新 adapter 实例 resume 它
  const cwd = tempDir('instead-codex-resume-');
  const adapter1 = new CodexAdapter({ command: codexCommand, sandboxMode: 'read-only', turnTimeoutMs: 60_000 });
  const h1 = await adapter1.start({ cwd });
  const first = await runTurnWithRetry(adapter1, h1, 'Reply with exactly: ONE');
  if (first.result.error && TRANSIENT_PROVIDER.test(first.result.error)) {
    await adapter1.stop(h1);
    t.skip(`provider 连续断流，环境不可用：${first.result.error}`);
    return;
  }
  assert.equal(first.result.error, undefined, `第一轮不应报错：${first.result.error ?? ''}`);
  const threadId = h1.ref.sessionId;
  await adapter1.stop(h1);

  const adapter2 = new CodexAdapter({ command: codexCommand, sandboxMode: 'read-only', turnTimeoutMs: 60_000 });
  const h2 = await adapter2.start({ cwd, sessionId: threadId });
  assert.equal(h2.ref.sessionId, threadId);
  const second = await runTurnWithRetry(
    adapter2,
    h2,
    'What did I ask you to reply with earlier? Answer with just that word.',
  );
  if (second.result.error && TRANSIENT_PROVIDER.test(second.result.error)) {
    await adapter2.stop(h2);
    t.skip(`provider 连续断流，环境不可用：${second.result.error}`);
    return;
  }
  assert.equal(second.result.error, undefined, `resume 不应报错：${second.result.error ?? ''}`);
  assert.match(second.result.text, /ONE/);
  await adapter2.stop(h2);
});
