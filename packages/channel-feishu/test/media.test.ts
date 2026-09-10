import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWithdrawnReplyError, mediaContent, mediaMsgType, textContent } from '../src/channel.ts';

/**
 * 出站附件 → 飞书消息形状。上传本身要真调 API（契约测试覆盖），
 * 这里钉的是「分类 + 消息体」这两个容易写错、又不需要网络的判断。
 */
test('图片走 image，其余一律走 file', () => {
  assert.equal(mediaMsgType('image'), 'image');
  assert.equal(mediaMsgType('file'), 'file');
  assert.equal(mediaMsgType('video'), 'file', '视频要封面 image_key，先当文件发');
});

test('消息体是飞书要的 image_key / file_key', () => {
  assert.deepEqual(JSON.parse(mediaContent('image', 'img_v3_abc')), { image_key: 'img_v3_abc' });
  assert.deepEqual(JSON.parse(mediaContent('file', 'file_v3_abc')), { file_key: 'file_v3_abc' });
  assert.deepEqual(JSON.parse(mediaContent('video', 'file_v3_abc')), { file_key: 'file_v3_abc' });
});

test('文本走富文本 post + md 元素（代码块/表格交给飞书渲染）', () => {
  const chunk = '```ts\nconst a = 1\n```';
  assert.deepEqual(JSON.parse(textContent(chunk)), {
    zh_cn: { content: [[{ tag: 'md', text: chunk }]] },
  });
});

test('撤回/找不到的 reply 目标要能认出来（否则这条出站会永远重试）', () => {
  assert.equal(isWithdrawnReplyError({ code: 230011 }), true);
  assert.equal(isWithdrawnReplyError({ code: 231003 }), true);
  assert.equal(isWithdrawnReplyError({ response: { data: { code: 230011 } } }), true);
  assert.equal(isWithdrawnReplyError({ msg: 'the message was withdrawn' }), true);
  assert.equal(isWithdrawnReplyError({ cause: { code: 231003 } }), true, 'axios 会把原因包一层');
  assert.equal(isWithdrawnReplyError({ code: 99991663 }), false, '别的错误码不能吃掉');
  assert.equal(isWithdrawnReplyError(new Error('boom')), false);
  assert.equal(isWithdrawnReplyError(null), false);
});
