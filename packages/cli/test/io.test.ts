import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureOutput, fail, ok, print, table } from '../src/io.ts';
import { formatBindings } from '../src/commands/bindings-table.ts';
import type { Binding } from '@instead/core';

test('print / ok / fail 的前缀', () => {
  const lines: string[] = [];
  const restore = captureOutput(lines);
  try {
    print('plain');
    ok('good');
    fail('bad');
  } finally {
    restore();
  }
  assert.deepEqual(lines, ['plain', '✓ good', '✗ bad']);
});

test('table 按内容自适应列宽', () => {
  const out = table(['A', 'BBBB'], [['xxxxx', 'y']]);
  assert.equal(out[0], 'A      BBBB');
  assert.equal(out[1], 'xxxxx  y');
});

test('table 不留行尾空白', () => {
  const out = table(['A', 'LONGHEADER'], [['x', 'y']]);
  for (const line of out) assert.equal(line, line.trimEnd(), `行尾有空白: ${JSON.stringify(line)}`);
});

/* ------------------------- 绑定总览表格 ------------------------- */

const binding = (over: Partial<Binding> = {}): Binding => ({
  chatId: 'oc_1',
  sessionId: 's1',
  agent: 'pi',
  cwd: '/w',
  ownerOpenId: 'ou_1',
  mirrorMode: 'off',
  createdAt: 1,
  ...over,
});

test('绑定表：运行中会话上报的模型优先于库里存的', () => {
  const rows = formatBindings([binding({ sessionId: 's1' })], (id) =>
    id === 's1' ? 'anthropic/claude-opus-4' : undefined,
  );
  assert.match(rows[1]!, /anthropic\/claude-opus-4/);
});

test('绑定表：没有模型信息时显示 -', () => {
  const rows = formatBindings([binding()], () => undefined);
  assert.match(rows[1]!, /\s-\s+ou_1$/);
});

test('绑定表：表头齐全', () => {
  const rows = formatBindings([binding()], () => undefined);
  for (const h of ['CHAT', 'SESSION', 'AGENT', 'MIRROR', 'MODEL', 'OWNER']) {
    assert.ok(rows[0]!.includes(h), `缺表头 ${h}`);
  }
});

test('绑定表：长 chat_id 不会挤坏对齐', () => {
  const rows = formatBindings(
    [binding({ chatId: 'oc_short' }), binding({ chatId: 'oc_' + 'x'.repeat(40) })],
    () => undefined,
  );
  const sessionCol = rows.map((r) => r.indexOf('s1')).filter((i) => i > 0);
  assert.equal(new Set(sessionCol).size, 1, 'SESSION 列必须对齐到同一列');
});
