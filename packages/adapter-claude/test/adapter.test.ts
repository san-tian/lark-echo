import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, buildArgs, buildPrompt, redactArgs } from '../src/adapter.ts';
import {
  assistantText,
  deltaText,
  parseStreamLine,
  sessionIdOf,
  toolUseNames,
} from '../src/stream-json.ts';
import {
  encodeProjectSlug,
  readTranscript,
  toHistoryEntry,
  transcriptExists,
  transcriptPath,
} from '../src/transcript.ts';

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

/** 契约测试需要真实的 claude CLI；没有就跳过（CI 友好） */
const hasClaude = ((): boolean => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// ── 纯函数：命令行 / 提示词 ────────────────────────────────────────────────

test('buildArgs：第一轮不带 --resume，权限模式默认不传', () => {
  assert.deepEqual(buildArgs({}), [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ]);
});

test('buildArgs：续跑 / 模型 / 权限模式 / 系统提示 / 额外参数', () => {
  const args = buildArgs({
    resume: 'sid-1',
    model: 'opus',
    permissionMode: 'acceptEdits',
    appendSystemPrompt: '<feishu_history>…</feishu_history>',
    extraArgs: ['--add-dir', '/tmp'],
  });
  assert.deepEqual(args, [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--resume',
    'sid-1',
    '--model',
    'opus',
    '--permission-mode',
    'acceptEdits',
    '--append-system-prompt',
    '<feishu_history>…</feishu_history>',
    '--add-dir',
    '/tmp',
  ]);
  assert.ok(!args.includes('default'), 'permissionMode 默认不能塞 "default"');
});

test('redactArgs：--append-system-prompt 的值不进日志', () => {
  const redacted = redactArgs(['-p', '--append-system-prompt', 'SECRET-GROUP-TEXT', '--model', 'opus']);
  assert.deepEqual(redacted, ['-p', '--append-system-prompt', '<17 chars>', '--model', 'opus']);
});

test('buildPrompt 把上下文放在真实消息之前', () => {
  const text = buildPrompt({
    text: '[张三 · 飞书] 看看',
    context: [
      {
        kind: 'pending-window',
        conversationKey: 'feishu:chat:oc_a',
        text: '<pending>旧消息</pending>',
      },
    ],
  });
  assert.match(text, /^<pending>旧消息<\/pending>\n\n\[张三 · 飞书\] 看看$/);
});

// ── 纯函数：stream-json 解析（行取自 spike 4 的真实输出）────────────────────

// 真实一行：system/init
const REAL_INIT =
  '{"type":"system","subtype":"init","cwd":"/tmp/claude-spike","session_id":"1d1d5531-2302-40ef-9968-cbecb2d25797","tools":["Task","Bash"],"model":"claude-opus-5[1m]","permissionMode":"default","claude_code_version":"2.1.258"}';
// 真实一行：流式文本增量
const REAL_DELTA =
  '{"type":"stream_event","event":{"delta":{"text":"O","type":"text_delta"},"index":0,"type":"content_block_delta"},"session_id":"1d1d5531-2302-40ef-9968-cbecb2d25797","parent_tool_use_id":null,"uuid":"49093d48-3078-4503-80e0-e0a127aaba8e"}';
// 真实一行：assistant 消息（tool_use 块）
const REAL_ASSISTANT_TOOL =
  '{"type":"assistant","message":{"content":[{"id":"toolu_bdrk_01TUxdmcMxLtQjB6ytTjdgr6","input":{"command":"echo hello-from-bash","description":"Echo a test string"},"name":"Bash","type":"tool_use"}],"role":"assistant","type":"message"},"parent_tool_use_id":null,"session_id":"1d1d5531-2302-40ef-9968-cbecb2d25797","uuid":"a55ee5b5-422a-4a53-91a0-bf048f99963f"}';
// 真实一行：result（最终文本）
const REAL_RESULT =
  '{"duration_api_ms":6346,"stop_reason":"end_turn","session_id":"1d1d5531-2302-40ef-9968-cbecb2d25797","permission_denials":[],"is_error":false,"num_turns":1,"subtype":"success","result":"OK","type":"result","duration_ms":6725}';

test('parseStreamLine：真实事件行能解析，非 JSON 行返回 undefined', () => {
  assert.equal(parseStreamLine(REAL_INIT)?.type, 'system');
  assert.equal(parseStreamLine(REAL_RESULT)?.type, 'result');
  assert.equal(parseStreamLine('No conversation found with session ID: xxx'), undefined);
  assert.equal(parseStreamLine('   '), undefined);
});

test('真实事件字段：session_id / text_delta / tool_use / result', () => {
  const init = parseStreamLine(REAL_INIT)!;
  assert.equal(sessionIdOf(init), '1d1d5531-2302-40ef-9968-cbecb2d25797');
  assert.equal((init as { permissionMode?: string }).permissionMode, 'default');

  const delta = parseStreamLine(REAL_DELTA)!;
  assert.equal(deltaText(delta), 'O');
  assert.equal(deltaText(parseStreamLine(REAL_INIT)!), undefined, 'init 不是 delta');

  const assistant = parseStreamLine(REAL_ASSISTANT_TOOL)!;
  assert.deepEqual(toolUseNames(assistant), ['Bash']);
  assert.equal(assistantText(assistant), '', '只有 tool_use 时没有文本');

  const result = parseStreamLine(REAL_RESULT)! as { result?: string; is_error?: boolean };
  assert.equal(result.result, 'OK');
  assert.equal(result.is_error, false);
});

// ── 转录 ──────────────────────────────────────────────────────────────────

test('encodeProjectSlug：非字母数字都变 -（实测 /tmp/claude.spike_x → -tmp-claude-spike-x）', () => {
  assert.equal(encodeProjectSlug('/home/dev/lark-echo'), '-home-dev-lark-echo');
  assert.equal(encodeProjectSlug('/tmp/claude.spike_x'), '-tmp-claude-spike-x');
});

test('toHistoryEntry：跳过 sidechain / 非消息 / 空文本', () => {
  assert.equal(
    toHistoryEntry({
      type: 'user',
      isSidechain: true,
      uuid: 'u1',
      message: { role: 'user', content: '子 agent 的话' },
    }),
    undefined,
  );
  assert.equal(toHistoryEntry({ type: 'attachment', uuid: 'a1' }), undefined);
  assert.equal(
    toHistoryEntry({
      type: 'user',
      uuid: 'u2',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] },
    }),
    undefined,
    '只有 tool_result 的 user 条目不算历史消息',
  );

  const user = toHistoryEntry({
    type: 'user',
    isSidechain: false,
    uuid: 'u3',
    timestamp: '2026-09-09T14:00:24.746Z',
    message: { role: 'user', content: 'Reply with exactly: OK' },
  });
  assert.deepEqual(user, {
    id: 'u3',
    role: 'user',
    text: 'Reply with exactly: OK',
    ts: Date.parse('2026-09-09T14:00:24.746Z'),
  });

  const assistant = toHistoryEntry({
    type: 'assistant',
    isSidechain: false,
    uuid: 'a3',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '内部思考' },
        { type: 'text', text: 'OK' },
      ],
    },
  });
  assert.equal(assistant?.role, 'assistant');
  assert.equal(assistant?.text, 'OK');
});

test('readTranscript：文件不存在返回空，游标之后的条目才 yield', async () => {
  const dir = tempDir('lark-echo-claude-tx-');
  const file = join(dir, 'sid.jsonl');
  assert.deepEqual(await collect(readTranscript(file)), []);

  const lines = [
    { type: 'user', isSidechain: false, uuid: 'e1', message: { role: 'user', content: '第一句' } },
    {
      type: 'assistant',
      isSidechain: false,
      uuid: 'e2',
      message: { role: 'assistant', content: [{ type: 'text', text: '第二句' }] },
    },
    {
      type: 'user',
      isSidechain: true,
      uuid: 'e3',
      message: { role: 'user', content: 'sidechain' },
    },
    { type: 'user', isSidechain: false, uuid: 'e4', message: { role: 'user', content: '第三句' } },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.deepEqual(
    (await collect(readTranscript(file))).map((e) => `${e.role}:${e.text}`),
    ['user:第一句', 'assistant:第二句', 'user:第三句'],
  );
  assert.deepEqual(
    (await collect(readTranscript(file, 'e2'))).map((e) => e.text),
    ['第三句'],
  );
});

test('transcriptPath / transcriptExists 跟随 projectsRoot', () => {
  const root = tempDir('lark-echo-claude-projects-');
  const cwd = '/tmp/claude.spike_x';
  assert.equal(
    transcriptPath(cwd, 'sid-1', root),
    join(root, '-tmp-claude-spike-x', 'sid-1.jsonl'),
  );
  assert.equal(transcriptExists(cwd, 'sid-1', root), false);
  mkdirSync(join(root, '-tmp-claude-spike-x'), { recursive: true });
  writeFileSync(join(root, '-tmp-claude-spike-x', 'sid-1.jsonl'), '');
  assert.equal(transcriptExists(cwd, 'sid-1', root), true);
});

// ── 适配器：用假 CLI 验证整条子进程链路（不需要 claude）────────────────────

/** 写一个假 claude：回显 argv 到 $FAKE_ARGS_LOG、stdin 到 $FAKE_PROMPT_LOG，再吐固定事件流 */
function writeFakeClaude(dir: string): string {
  const file = join(dir, 'fake-claude.sh');
  writeFileSync(
    file,
    `#!/bin/bash
if [ -n "$FAKE_ARGS_LOG" ]; then printf '%s\\n' "$@" > "$FAKE_ARGS_LOG"; fi
if [ -n "$FAKE_PROMPT_LOG" ]; then cat > "$FAKE_PROMPT_LOG"; fi
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"fake-session-1","model":"fake","permissionMode":"default"}'
printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"he"}},"session_id":"fake-session-1"}'
printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"llo"}},"session_id":"fake-session-1"}'
printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","id":"t1"}]},"session_id":"fake-session-1"}'
printf '%s\\n' '{"type":"system","subtype":"permission_denied","tool_name":"WebSearch","session_id":"fake-session-1"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"fake-session-1"}'
exit 0
`,
  );
  chmodSync(file, 0o755);
  return file;
}

test('适配器：假 CLI 跑通 delta/final/tool，第二轮带上 --resume，上下文进 --append-system-prompt', async () => {
  const dir = tempDir('lark-echo-claude-fake-');
  const command = writeFakeClaude(dir);
  const argsLog = join(dir, 'args.log');
  const promptLog = join(dir, 'prompt.log');
  process.env.FAKE_ARGS_LOG = argsLog;
  process.env.FAKE_PROMPT_LOG = promptLog;
  try {
    const adapter = new ClaudeAdapter({ command, projectsRoot: join(dir, 'projects') });
    const handle = await adapter.start({ cwd: dir, sessionId: 'session-1' });
    assert.equal(handle.ref.agent, 'claude');
    assert.equal(handle.ref.sessionId, 'session-1');
    assert.deepEqual(handle.capabilities, {
      persistent: false,
      steer: false,
      liveAttach: 'lease',
      approvals: false,
      modelSwitch: 'restart',
    });

    const turn = await adapter.send(handle, {
      text: '你好',
      context: [
        { kind: 'pending-window', conversationKey: 'feishu:chat:oc_a', text: '<pending>旧消息</pending>' },
      ],
    });
    const deltas: string[] = [];
    const tools: string[] = [];
    turn.onEvent((event) => {
      if (event.type === 'delta' && event.text) deltas.push(event.text);
      if (event.type === 'tool' && event.text) tools.push(event.text);
    });
    const first = await turn.settled;
    assert.equal(first.error, undefined);
    assert.equal(first.aborted, false);
    assert.equal(first.text, 'hello');
    assert.equal(deltas.join(''), 'hello');
    assert.deepEqual(tools, ['Bash', 'permission-denied: WebSearch']);

    // 第一轮：不带 --resume；prompt 走 stdin
    const firstArgs = readFileSync(argsLog, 'utf8').trim().split('\n');
    assert.ok(!firstArgs.includes('--resume'), `第一轮不该有 --resume：${firstArgs.join(' ')}`);
    assert.equal(firstArgs[0], '-p');
    assert.equal(readFileSync(promptLog, 'utf8'), '<pending>旧消息</pending>\n\n你好\n');

    // 第二轮：学到 fake-session-1 → --resume 它；injectContext 进 --append-system-prompt
    await adapter.injectContext(handle, {
      kind: 'historical',
      conversationKey: 'feishu:chat:oc_a',
      text: '<feishu_history>只读历史</feishu_history>',
    });
    const second = await (await adapter.send(handle, { text: '再来一次' })).settled;
    assert.equal(second.text, 'hello');
    const secondArgs = readFileSync(argsLog, 'utf8').trim().split('\n');
    assert.deepEqual(secondArgs.slice(0, 8), [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--resume',
      'fake-session-1',
      '--append-system-prompt',
    ]);
    assert.equal(secondArgs[8], '<feishu_history>只读历史</feishu_history>');

    await adapter.stop(handle);
  } finally {
    delete process.env.FAKE_ARGS_LOG;
    delete process.env.FAKE_PROMPT_LOG;
  }
});

test('适配器：子进程非零退出且没有 result 事件 → error', async () => {
  const dir = tempDir('lark-echo-claude-fail-');
  const command = join(dir, 'fail.sh');
  writeFileSync(command, '#!/bin/bash\necho "boom" >&2\nexit 1\n');
  chmodSync(command, 0o755);
  const adapter = new ClaudeAdapter({ command, projectsRoot: join(dir, 'projects') });
  const handle = await adapter.start({ cwd: dir, sessionId: 'session-fail' });
  const result = await (await adapter.send(handle, { text: 'hi' })).settled;
  assert.equal(result.text, '');
  assert.match(result.error ?? '', /claude exited \(code 1\): boom/);
});

// ── 契约测试（真实 claude 2.1.258）────────────────────────────────────────

test('契约：真实 claude 一轮跑通，最终文本来自 result 事件', { skip: !hasClaude, timeout: 180_000 }, async () => {
  const cwd = tempDir('lark-echo-claude-live-');
  const adapter = new ClaudeAdapter();
  const handle = await adapter.start({ cwd, sessionId: 'contract-claude-001' });
  assert.equal(handle.ref.sessionId, 'contract-claude-001');

  const turn = await adapter.send(handle, { text: 'Reply with exactly: OK' });
  const deltas: string[] = [];
  turn.onEvent((event) => {
    if (event.type === 'delta' && event.text) deltas.push(event.text);
  });
  const result = await turn.settled;
  assert.equal(result.aborted, false);
  assert.equal(result.error, undefined);
  assert.match(result.text, /OK/);
  assert.ok(deltas.length > 0, '应收到流式 delta');
  assert.match(deltas.join(''), /OK/);
  await adapter.stop(handle);
});

test('契约：同一 session 第二轮 --resume 记得上一轮，history() 读得到转录', { skip: !hasClaude, timeout: 300_000 }, async () => {
  const cwd = tempDir('lark-echo-claude-resume-');
  const adapter = new ClaudeAdapter();
  const handle = await adapter.start({ cwd, sessionId: 'contract-claude-002' });

  const first = await (await adapter.send(handle, { text: 'Reply with exactly: ONE' })).settled;
  assert.match(first.text, /ONE/);

  const second = await (
    await adapter.send(handle, {
      text: 'What word did I ask you to reply with? Reply with just that word.',
    })
  ).settled;
  assert.equal(second.error, undefined);
  assert.match(second.text, /ONE/, `续跑应记得上一轮，实际：${second.text}`);

  const entries: string[] = [];
  for await (const entry of adapter.history(handle)) entries.push(`${entry.role}:${entry.text}`);
  assert.ok(
    entries.some((entry) => entry.startsWith('user:') && entry.includes('ONE')),
    `history 应包含第一轮的用户消息，实际：${entries.join(' | ')}`,
  );
  assert.ok(
    entries.some((entry) => entry.startsWith('assistant:')),
    `history 应包含 assistant 消息，实际：${entries.join(' | ')}`,
  );
  await adapter.stop(handle);
});

async function collect(iterable: AsyncIterable<{ role: string; text: string; id: string }>) {
  const out: { role: string; text: string; id: string }[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
