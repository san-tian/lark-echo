import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatChatTools, formatPendingWindow } from '../src/pending-window.ts';
import { inbound, keyFor } from './helpers.ts';

const CHAT = 'oc_abc123';
const KEY = keyFor(CHAT);

test('注入块教的是 MEDIA 约定，而不是拼 lark-cli 命令', () => {
  const block = formatChatTools(KEY);
  assert.equal(block.kind, 'instructions');
  assert.equal(block.conversationKey, KEY);
  assert.match(block.text, /MEDIA:<相对当前工作目录的路径>/);
  assert.equal(/lark-cli im /.test(block.text), false, '决策 23：上传与发送收回到 instead');
});

test('决策 23 之后不再需要 chat_id（少一处泄露）', () => {
  assert.equal(formatChatTools(KEY).text.includes(CHAT), false);
});

test('先禁止重复回复，再授权发文件（顺序很重要）', () => {
  const text = formatChatTools(KEY).text;
  const banIndex = text.indexOf('不要');
  const allowIndex = text.indexOf('MEDIA:');
  assert.ok(banIndex >= 0, '要有明确的禁止');
  assert.ok(allowIndex >= 0, '要给出发文件的写法');
  assert.ok(banIndex < allowIndex, '禁止必须排在授权之前，否则模型容易只记住授权');
});

test('明说最终回复会自动送达 —— 这是防重复的关键一句', () => {
  assert.match(formatChatTools(KEY).text, /自动/);
});

test('提醒路径必须在工作目录内、必须独占一行', () => {
  const text = formatChatTools(KEY).text;
  assert.match(text, /单独占一行/);
  assert.match(text, /工作目录/);
  assert.match(text, /绝对路径/);
  assert.match(text, /\.\./);
});

test('可选带上群名', () => {
  assert.equal(formatChatTools(KEY, '研发群').chatName, '研发群');
  assert.equal(formatChatTools(KEY).chatName, undefined);
});

/* ---------------- 与决策 21 的边界：默认注入不能泄露群的存在 ---------------- */

test('pendingWindow 仍然是中性的，不提飞书/群，也不含 chat_id', () => {
  const msg = inbound({ chatId: CHAT, text: '现在呢' });
  const block = formatPendingWindow(msg, [inbound({ chatId: CHAT, text: '之前说的' })]);
  assert.ok(block);
  assert.equal(/飞书|群|请回应/.test(block.text), false, '决策 21：不做群/飞书包装');
  assert.equal(block.text.includes(CHAT), false, 'chat_id 不该出现在默认注入里');
});
