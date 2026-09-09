import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionQueue } from '../src/queue.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const task = (chatId: string, name: string, order: string[], ms = 15) => ({
  chatId,
  enqueuedAt: Date.now(),
  run: async () => {
    order.push(`start:${name}`);
    await sleep(ms);
    order.push(`end:${name}`);
  },
});

test('同一 session 的任务严格串行（§9）', async () => {
  const q = new SessionQueue();
  const order: string[] = [];
  q.enqueue('s1', task('oc_a', 'a', order));
  q.enqueue('s1', task('oc_b', 'b', order));
  q.enqueue('s1', task('oc_a', 'c', order));
  await q.idle('s1');
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
});

test('不同 session 可并发', async () => {
  const q = new SessionQueue();
  const order: string[] = [];
  q.enqueue('s1', task('oc_a', 'a', order, 30));
  q.enqueue('s2', task('oc_b', 'b', order, 30));
  await sleep(10);
  assert.deepEqual(order, ['start:a', 'start:b']);
  await Promise.all([q.idle('s1'), q.idle('s2')]);
});

test('排队回执：返回前面还有几条', async () => {
  const q = new SessionQueue();
  const order: string[] = [];
  const first = q.enqueue('s1', task('oc_a', 'a', order, 20));
  const second = q.enqueue('s1', task('oc_b', 'b', order, 20));
  assert.equal(first.ahead, 0);
  assert.equal(second.ahead, 1);
  await q.idle('s1');
});

test('单群排队上限：超出丢弃并回调', async () => {
  const q = new SessionQueue({ maxPerChat: 2 });
  const dropped: string[] = [];
  const mk = (name: string) => ({
    ...task('oc_a', name, [], 20),
    onDrop: (reason: string) => dropped.push(`${name}:${reason}`),
  });
  q.enqueue('s1', mk('a'));
  q.enqueue('s1', mk('b'));
  const third = q.enqueue('s1', mk('c'));
  assert.equal(third.dropped, true);
  await q.idle('s1');
  assert.deepEqual(dropped, ['c:overflow']);
});

test('控制类消息旁路：不排队，立刻执行（缺口 A）', async () => {
  const q = new SessionQueue();
  const order: string[] = [];
  q.enqueue('s1', task('oc_a', 'long', order, 40));
  await q.bypass(async () => {
    order.push('control');
  });
  assert.deepEqual(order, ['start:long', 'control']);
  await q.idle('s1');
});
