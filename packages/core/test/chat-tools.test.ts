import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatChatTools, formatPendingWindow } from '../src/pending-window.ts';
import { inbound, keyFor } from './helpers.ts';

const CHAT = 'oc_abc123';
const KEY = keyFor(CHAT);

test('注入块带上 chat_id，agent 才知道往哪发', () => {
  const block = formatChatTools(KEY, CHAT);
  assert.equal(block.kind, 'instructions');
  assert.equal(block.conversationKey, KEY);
  assert.match(block.text, /--chat-id oc_abc123/);
});

test('必须要求 --as bot（否则会以用户本人身份发出）', () => {
  // 这是决策 21 里「wrong-identity sends」的直接来源：agent 用的是用户自己的
  // lark-cli 凭据，不显式指定身份就是用户在发言。
  assert.match(formatChatTools(KEY, CHAT).text, /--as bot/);
});

test('先禁止重复回复，再授权发文件（顺序很重要）', () => {
  const text = formatChatTools(KEY, CHAT).text;
  const banIndex = text.indexOf('不要');
  const allowIndex = text.indexOf('messages-send');
  assert.ok(banIndex >= 0, '要有明确的禁止');
  assert.ok(allowIndex >= 0, '要给出发文件的命令');
  assert.ok(banIndex < allowIndex, '禁止必须排在授权之前，否则模型容易只记住授权');
});

test('明说最终回复会自动送达 —— 这是防重复的关键一句', () => {
  assert.match(formatChatTools(KEY, CHAT).text, /自动/);
});

test('提醒路径必须相对 cwd（lark-cli 会拒绝绝对路径与 ..）', () => {
  const text = formatChatTools(KEY, CHAT).text;
  assert.match(text, /相对/);
  assert.match(text, /\.\./);
});

test('可选带上群名', () => {
  assert.equal(formatChatTools(KEY, CHAT, '研发群').chatName, '研发群');
  assert.equal(formatChatTools(KEY, CHAT).chatName, undefined);
});

/* ---------------- 与决策 21 的边界：默认注入不能泄露群的存在 ---------------- */

test('pendingWindow 仍然是中性的，不提飞书/群，也不含 chat_id', () => {
  const msg = inbound({ chatId: CHAT, text: '现在呢' });
  const block = formatPendingWindow(msg, [inbound({ chatId: CHAT, text: '之前说的' })]);
  assert.ok(block);
  assert.equal(/飞书|群|请回应/.test(block.text), false, '决策 21：不做群/飞书包装');
  assert.equal(block.text.includes(CHAT), false, 'chat_id 不该出现在默认注入里');
});
