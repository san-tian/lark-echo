import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAttachments,
  extractText,
  toHistoryMessage,
  toInboundMessage,
} from '../src/mapper.ts';

const baseEvent = (overrides: {
  message?: Record<string, unknown>;
  sender?: Record<string, unknown>;
} = {}) => ({
  event_id: 'evt-1',
  sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user', ...(overrides.sender ?? {}) },
  message: {
    message_id: 'om_1',
    chat_id: 'oc_1',
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text: 'hello' }),
    create_time: '1700000000000',
    ...(overrides.message ?? {}),
  },
});

test('文本消息 → 统一入站消息', () => {
  const msg = toInboundMessage(baseEvent(), { botOpenId: 'ou_bot' });
  assert.ok(msg);
  assert.equal(msg.conversationKey, 'feishu:chat:oc_1');
  assert.equal(msg.actor.id, 'ou_user');
  assert.equal(msg.text, 'hello');
  assert.equal(msg.mentioned, false);
  assert.equal(msg.replyTo, 'om_1');
  assert.equal(msg.ts, 1700000000000);
});

test('@机器人时 mentioned=true，并从正文里剥掉 mention key', () => {
  const msg = toInboundMessage(
    baseEvent({
      message: {
        content: JSON.stringify({ text: '@_user_1 帮我看看' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Instead' }],
      },
    }),
    { botOpenId: 'ou_bot' },
  );
  assert.equal(msg?.mentioned, true);
  assert.equal(msg?.text, '帮我看看');
});

test('别人被 @ 不算 mention', () => {
  const msg = toInboundMessage(
    baseEvent({
      message: {
        content: JSON.stringify({ text: '@_user_1 hi' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_other' } }],
      },
    }),
    { botOpenId: 'ou_bot' },
  );
  assert.equal(msg?.mentioned, false);
});

test('机器人自己发的消息被忽略（防回环）', () => {
  const event = baseEvent({
    sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'app' },
  });
  assert.equal(toInboundMessage(event, { botOpenId: 'ou_bot' }), undefined);
});

test('缺 chat_id / message_id 时忽略', () => {
  const event = baseEvent({ message: { chat_id: undefined, message_id: undefined } });
  assert.equal(toInboundMessage(event, {}), undefined);
});

test('话题群 thread_id 透传（缺口 H）', () => {
  const msg = toInboundMessage(baseEvent({ message: { thread_id: 'omt_1' } }), {});
  assert.equal(msg?.threadId, 'omt_1');
});

test('图片/文件/语音用占位符', () => {
  assert.equal(extractText('image', JSON.stringify({ image_key: 'k' })), '[图片]');
  assert.equal(
    extractText('file', JSON.stringify({ file_key: 'k', file_name: 'a.pdf' })),
    '[文件: a.pdf]',
  );
  assert.equal(extractText('audio', '{}'), '[语音]');
});

test('富文本（post）抽取文本节点', () => {
  const content = JSON.stringify({
    title: '标题',
    content: [
      [{ tag: 'text', text: '第一行' }, { tag: 'at', user_name: '张三' }],
      [{ tag: 'text', text: '第二行' }],
    ],
  });
  assert.equal(extractText('post', content), '标题\n第一行@张三\n第二行');
});

test('发送者姓名由调用方注入', () => {
  const msg = toInboundMessage(baseEvent(), { senderName: '张三' });
  assert.equal(msg?.actor.name, '张三');
});

test('toHistoryMessage：文本/系统/空文本/机器人', () => {
  const text = toHistoryMessage({
    message_id: 'om_1',
    msg_type: 'text',
    body: { content: JSON.stringify({ text: '你好 @_user_1' }) },
    create_time: '1700000000000',
    sender: { id: 'ou_abc', sender_type: 'user' },
  });
  assert.equal(text?.text, '你好');
  assert.match(text!.senderName, /ou_ab/);
  assert.equal(text!.ts, 1700000000000);

  // 机器人消息标成「机器人」
  const bot = toHistoryMessage({
    message_id: 'om_b',
    msg_type: 'text',
    body: { content: JSON.stringify({ text: 'hi' }) },
    create_time: '1',
    sender: { id: 'cli_x', sender_type: 'app' },
  });
  assert.equal(bot?.senderName, '机器人');

  assert.equal(toHistoryMessage({ message_id: 'om_2', msg_type: 'system' }), undefined);
  assert.equal(toHistoryMessage({ msg_type: 'text', body: { content: '{}' } }), undefined);
});

/* ---------------- 决策 23：收集可下载的附件 ---------------- */

test('图片/文件/语音/视频各自抽出资源键', () => {
  assert.deepEqual(extractAttachments('image', JSON.stringify({ image_key: 'img_1' })), [
    { kind: 'image', key: 'img_1' },
  ]);
  assert.deepEqual(
    extractAttachments('file', JSON.stringify({ file_key: 'f_1', file_name: '报表.csv' })),
    [{ kind: 'file', key: 'f_1', name: '报表.csv' }],
  );
  assert.deepEqual(extractAttachments('audio', JSON.stringify({ file_key: 'a_1' })), [
    { kind: 'audio', key: 'a_1' },
  ]);
  assert.deepEqual(
    extractAttachments('media', JSON.stringify({ file_key: 'v_1', image_key: 'cover_1' })),
    [{ kind: 'video', key: 'v_1' }],
  );
});

test('富文本里的 img 节点也算附件', () => {
  const content = JSON.stringify({
    content: [
      [{ tag: 'text', text: '看这张' }],
      [{ tag: 'img', image_key: 'img_a' }, { tag: 'img', image_key: 'img_b' }],
    ],
  });
  assert.deepEqual(extractAttachments('post', content), [
    { kind: 'image', key: 'img_a' },
    { kind: 'image', key: 'img_b' },
  ]);
});

test('纯文本 / 表情 / 坏 JSON 都不产出附件', () => {
  assert.deepEqual(extractAttachments('text', JSON.stringify({ text: 'hi' })), []);
  assert.deepEqual(extractAttachments('sticker', JSON.stringify({ file_key: 's_1' })), []);
  assert.deepEqual(extractAttachments('image', 'not json'), []);
});

test('toInboundMessage 把附件挂到消息上（文本占位符保留）', () => {
  const msg = toInboundMessage(
    baseEvent({
      message: {
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_1' }),
      },
    }),
    {},
  );
  assert.equal(msg?.text, '[图片]', '占位符保留：写进 pendingWindow/历史时得看得见');
  assert.deepEqual(msg?.attachments, [{ kind: 'image', key: 'img_1' }]);
});

test('话题根消息只有 root_id 也视为在话题里（决策 24）', () => {
  const msg = toInboundMessage(baseEvent({ message: { root_id: 'omt_root' } }), {});
  assert.equal(msg?.threadId, 'omt_root');
});

test('thread_id 优先于 root_id', () => {
  const msg = toInboundMessage(
    baseEvent({ message: { thread_id: 'omt_1', root_id: 'omt_root' } }),
    {},
  );
  assert.equal(msg?.threadId, 'omt_1');
});
