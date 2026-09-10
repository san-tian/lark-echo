import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaContent, mediaMsgType } from '../src/channel.ts';

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
