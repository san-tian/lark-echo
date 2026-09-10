import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  extractMediaRefs,
  matchMediaLine,
  mediaKindFor,
  resolveInsideCwd,
} from '../src/media-ref.ts';

test('MEDIA 行：可选反引号/空白，路径两边的噪声去掉', () => {
  assert.equal(matchMediaLine('MEDIA:out/a.png'), 'out/a.png');
  assert.equal(matchMediaLine('  MEDIA:  `out/a.png`  '), 'out/a.png');
  assert.equal(matchMediaLine('MEDIA: /tmp/x y.png'), '/tmp/x y.png', '路径里可以有空格');
});

test('MEDIA 行：必须是整行 —— 内联提到约定不能触发发送', () => {
  assert.equal(matchMediaLine('写 MEDIA:a.png 就能发图'), undefined);
  assert.equal(matchMediaLine('# MEDIA:a.png'), undefined, '注释行也算另一种写法，别猜');
  assert.equal(matchMediaLine('MEDIA:'), undefined);
  assert.equal(matchMediaLine('MEDIA:   '), undefined);
});

test('extractMediaRefs：按出现顺序抽走，其余文本保留', () => {
  const out = extractMediaRefs('第一行\nMEDIA:a.png\n\n\nMEDIA:b.csv\n最后一行');
  assert.deepEqual(out.refs, ['a.png', 'b.csv']);
  assert.equal(out.text, '第一行\n\n最后一行', '连续空行压成一个，首尾 trim');
});

test('resolveInsideCwd：cwd 内解析成绝对路径', () => {
  assert.equal(resolveInsideCwd('out/a.png', '/repo'), '/repo/out/a.png');
  assert.equal(resolveInsideCwd('./a.png', '/repo'), '/repo/a.png');
  assert.equal(resolveInsideCwd('/repo/a.png', '/repo'), '/repo/a.png');
});

test('resolveInsideCwd：越界一律 undefined', () => {
  assert.equal(resolveInsideCwd('../a.png', '/repo'), undefined);
  assert.equal(resolveInsideCwd('/etc/passwd', '/repo'), undefined);
  assert.equal(resolveInsideCwd('/repo', '/repo'), undefined, '目录本身不是文件');
  assert.equal(resolveInsideCwd('/repofake/a.png', '/repo'), undefined, '前缀像但不同目录');
  assert.equal(resolveInsideCwd('https://x.com/a.png', '/repo'), undefined, 'v1 不拉远端');
  assert.equal(resolveInsideCwd('file:///repo/a.png', '/repo'), undefined);
});

test('mediaKindFor：按扩展名分图/文件', () => {
  assert.equal(mediaKindFor('/repo/a.PNG'), 'image');
  assert.equal(mediaKindFor('/repo/a.jpeg'), 'image');
  assert.equal(mediaKindFor('/repo/a.webp'), 'image');
  assert.equal(mediaKindFor('/repo/a.csv'), 'file');
  assert.equal(mediaKindFor('/repo/README'), 'file', '没扩展名当文件');
  assert.equal(mediaKindFor('/repo/a.mp4'), 'file', '视频要封面，先当文件发');
});

test('大小上限对齐飞书（图 10MB / 文件 30MB）', () => {
  assert.equal(MAX_IMAGE_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_FILE_BYTES, 30 * 1024 * 1024);
});
