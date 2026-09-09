import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter } from '@lark-echo/core/testing';
import type { SessionRef } from '@lark-echo/core';
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
  await pool.release('s1');
  assert.deepEqual(
    pool.list().map((s) => s.ref.sessionId),
    ['s2'],
  );
  await pool.closeAll();
});

test('没有注册的 agent 会明确报错', async () => {
  const pool = new SessionPool({ adapters: {} });
  await assert.rejects(() => pool.acquire(ref()), /no adapter registered/);
});
