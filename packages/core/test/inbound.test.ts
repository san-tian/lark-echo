import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inbound, memoryDb } from './helpers.ts';
import {
  clearPendingWindow,
  countPendingInbound,
  pendingWindowFor,
  recordInbound,
} from '../src/state/inbound.ts';

test('按 event_id 去重', () => {
  const db = memoryDb();
  assert.equal(recordInbound(db, inbound({ chatId: 'oc_a', id: 'evt-1' }), 'sess-1'), true);
  assert.equal(recordInbound(db, inbound({ chatId: 'oc_a', id: 'evt-1' }), 'sess-1'), false);
  assert.equal(countPendingInbound(db), 1);
});

test('@ 的消息进 pending，未 @ 的进 context', () => {
  const db = memoryDb();
  recordInbound(db, inbound({ chatId: 'oc_a', id: 'e1', mentioned: true, text: '帮我看看' }), 'sess-1');
  recordInbound(db, inbound({ chatId: 'oc_a', id: 'e2', mentioned: false, text: '旁观一' }), 'sess-1');
  recordInbound(db, inbound({ chatId: 'oc_a', id: 'e3', mentioned: false, text: '旁观二' }), 'sess-1');
  assert.equal(countPendingInbound(db), 1);
  const window = pendingWindowFor(db, 'oc_a', 50);
  assert.deepEqual(
    window.map((m) => m.text),
    ['旁观一', '旁观二'],
  );
});

test('pendingWindow 按 chat 隔离，清空只影响该群（§6.1）', () => {
  const db = memoryDb();
  recordInbound(db, inbound({ chatId: 'oc_a', id: 'a1', mentioned: false }), 'sess-1');
  recordInbound(db, inbound({ chatId: 'oc_b', id: 'b1', mentioned: false }), 'sess-1');
  clearPendingWindow(db, 'oc_a');
  assert.equal(pendingWindowFor(db, 'oc_a', 50).length, 0);
  assert.equal(pendingWindowFor(db, 'oc_b', 50).length, 1);
});

test('pendingWindow 上限取最近 N 条', () => {
  const db = memoryDb();
  for (let i = 0; i < 5; i++) {
    recordInbound(
      db,
      inbound({ chatId: 'oc_a', id: `e${i}`, mentioned: false, text: `m${i}`, ts: 1000 + i }),
      'sess-1',
    );
  }
  assert.deepEqual(
    pendingWindowFor(db, 'oc_a', 2).map((m) => m.text),
    ['m3', 'm4'],
  );
});
