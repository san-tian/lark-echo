import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inbound, memoryDb } from './helpers.ts';
import { insertBinding } from '../src/state/bindings.ts';
import { decideInbound, sessionRefFor } from '../src/router.ts';

test('未绑定的群 → unbound', () => {
  const db = memoryDb();
  assert.equal(decideInbound(db, inbound({ chatId: 'oc_x' })).action, 'unbound');
});

test('绑定者 @机器人 → trigger', () => {
  const db = memoryDb();
  insertBinding(db, {
    chatId: 'oc_a',
    sessionId: 'sess-1',
    agent: 'pi',
    cwd: '/repo',
    ownerOpenId: 'ou_owner',
    mirrorMode: 'off',
    createdAt: 1,
  });
  const decision = decideInbound(
    db,
    inbound({ chatId: 'oc_a', mentioned: true, actor: { id: 'ou_owner', name: '张三' } }),
  );
  assert.equal(decision.action, 'trigger');
  assert.equal(sessionRefFor(db, 'oc_a')?.sessionId, 'sess-1');
});

test('非绑定者 @机器人 → context（不进 transcript，只作上下文）', () => {
  const db = memoryDb();
  insertBinding(db, {
    chatId: 'oc_a',
    sessionId: 'sess-1',
    agent: 'pi',
    cwd: '/repo',
    ownerOpenId: 'ou_owner',
    mirrorMode: 'off',
    createdAt: 1,
  });
  const decision = decideInbound(
    db,
    inbound({ chatId: 'oc_a', mentioned: true, actor: { id: 'ou_other', name: '李四' } }),
  );
  assert.equal(decision.action, 'context');
});

test('未 @ 的消息 → context', () => {
  const db = memoryDb();
  insertBinding(db, {
    chatId: 'oc_a',
    sessionId: 'sess-1',
    agent: 'pi',
    cwd: '/repo',
    ownerOpenId: 'ou_owner',
    mirrorMode: 'off',
    createdAt: 1,
  });
  assert.equal(decideInbound(db, inbound({ chatId: 'oc_a', mentioned: false })).action, 'context');
});

test('话题群 → thread-unsupported（缺口 H）', () => {
  const db = memoryDb();
  insertBinding(db, {
    chatId: 'oc_a',
    sessionId: 'sess-1',
    agent: 'pi',
    cwd: '/repo',
    ownerOpenId: 'ou_owner',
    mirrorMode: 'off',
    createdAt: 1,
  });
  const decision = decideInbound(db, inbound({ chatId: 'oc_a', threadId: 'omt_123' }));
  assert.equal(decision.action, 'thread-unsupported');
});
