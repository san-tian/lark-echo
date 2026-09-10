import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bool, flag, parseArgs } from '../src/args.ts';

test('位置参数与 flag 混排', () => {
  const a = parseArgs(['bind', '--agent', 'claude', 'extra', '--anyone']);
  assert.deepEqual(a.positional, ['bind', 'extra']);
  assert.equal(a.flags.agent, 'claude');
  assert.equal(a.flags.anyone, true);
});

test('--key=value 形态', () => {
  const a = parseArgs(['ui', '--host=100.64.0.1', '--port=8080']);
  assert.equal(a.flags.host, '100.64.0.1');
  assert.equal(a.flags.port, '8080');
});

test('值里带 = 不会被截断', () => {
  // 原实现用 split('=') destructure，`a=b` 会只剩 `a`
  const a = parseArgs(['model', '--opt=key=value=more']);
  assert.equal(a.flags.opt, 'key=value=more');
});

test('最后一个 flag 没值时是布尔真', () => {
  const a = parseArgs(['ui', '--auth']);
  assert.equal(a.flags.auth, true);
});

test('flag 后面跟着另一个 flag 时不吞它', () => {
  const a = parseArgs(['ui', '--auth', '--no-open']);
  assert.equal(a.flags.auth, true);
  assert.equal(a.flags['no-open'], true);
});

test('-- 之后一律当位置参数', () => {
  const a = parseArgs(['bind', '--', '--not-a-flag', 'x']);
  assert.deepEqual(a.positional, ['bind', '--not-a-flag', 'x']);
  assert.equal(Object.keys(a.flags).length, 0);
});

test('flag() 只认字符串值，布尔 flag 返回 undefined', () => {
  const a = parseArgs(['ui', '--auth', '--host', '1.2.3.4']);
  assert.equal(flag(a, 'host'), '1.2.3.4');
  assert.equal(flag(a, 'auth'), undefined, '布尔 flag 不是字符串');
  assert.equal(flag(a, 'missing'), undefined);
});

test('bool() 认 --foo 与 --foo=true', () => {
  assert.equal(bool(parseArgs(['ui', '--auth']), 'auth'), true);
  assert.equal(bool(parseArgs(['ui', '--auth=true']), 'auth'), true);
  assert.equal(bool(parseArgs(['ui']), 'auth'), false);
  assert.equal(bool(parseArgs(['ui', '--auth=false']), 'auth'), false);
});

test('空 argv → 无命令', () => {
  const a = parseArgs([]);
  assert.equal(a.positional[0], undefined);
});
