import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter } from '@anylark/core/testing';
import type { SessionRef } from '@anylark/core';
import { SessionPool } from '../src/session-pool.ts';

const ref = (sessionId = 'sess-1'): SessionRef => ({
  agent: 'pi',
  sessionId,
  cwd: '/repo',
  driver: 'daemon',
});

test('同一 session 复用同一个进程（§11.4）', async () => {
  const adapter = new FakeAdapter();
  const pool = new SessionPool({ adapters: { pi: adapter } });
  await pool.acquire(ref());
  await pool.acquire(ref());
  assert.equal(adapter.startCount, 1);
  assert.equal(pool.list().length, 1);
  await pool.closeAll();
});

test('idle 回收会停掉进程', async () => {
  let now = 1000;
  const adapter = new FakeAdapter();
  const pool = new SessionPool({
    adapters: { pi: adapter },
    idleMs: 500,
    now: () => now,
  });
  await pool.acquire(ref());
  now = 2000;
  const released = await pool.sweep();
  assert.deepEqual(released, ['sess-1']);
  assert.equal(pool.list().length, 0);
  // 回收后再次 acquire 会重新起进程
  await pool.acquire(ref());
  assert.equal(adapter.startCount, 2);
  await pool.closeAll();
});

test('release 指定 session', async () => {
  const pool = new SessionPool({ adapters: { pi: new FakeAdapter() } });
  await pool.acquire(ref('s1'));
  await pool.acquire(ref('s2'));
  assert.equal(await pool.release('s1'), true, '真的释放了要返回 true');
  assert.deepEqual(
    pool.list().map((s) => s.ref.sessionId),
    ['s2'],
  );
  await pool.closeAll();
});

test('release 不存在的 session 返回 false（调用方要靠它区分「已停」和「本来没跑」）', async () => {
  const pool = new SessionPool({ adapters: { pi: new FakeAdapter() } });
  assert.equal(await pool.release('never-existed'), false);
  await pool.acquire(ref('s1'));
  assert.equal(await pool.release('s1'), true);
  assert.equal(await pool.release('s1'), false, '重复 release 第二次是 false');
  await pool.closeAll();
});

test('没有注册的 agent 会明确报错', async () => {
  const pool = new SessionPool({ adapters: {} });
  await assert.rejects(() => pool.acquire(ref()), /no adapter registered/);
});
