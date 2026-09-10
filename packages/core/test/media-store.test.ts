import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneMedia } from '../src/media-store.ts';

const root = (): string => mkdtempSync(join(tmpdir(), 'instead-media-prune-'));
const old = (p: string): void => utimesSync(p, new Date(0), new Date(0));

test('只删过期文件，新的留着', async () => {
  const dir = root();
  mkdirSync(join(dir, 'oc_a'));
  writeFileSync(join(dir, 'oc_a', 'stale.png'), 'x');
  writeFileSync(join(dir, 'oc_a', 'fresh.png'), 'y');
  old(join(dir, 'oc_a', 'stale.png'));

  assert.equal(await pruneMedia(dir, 1000, Date.now()), 1);
  assert.deepEqual(readdirSync(join(dir, 'oc_a')), ['fresh.png']);
});

test('整个群目录都过期了就收掉，其他群不动', async () => {
  const dir = root();
  mkdirSync(join(dir, 'oc_old'));
  mkdirSync(join(dir, 'oc_new'));
  writeFileSync(join(dir, 'oc_old', 'a.png'), 'x');
  writeFileSync(join(dir, 'oc_new', 'b.png'), 'y');
  old(join(dir, 'oc_old', 'a.png'));

  assert.equal(await pruneMedia(dir, 1000, Date.now()), 1);
  assert.equal(existsSync(join(dir, 'oc_old')), false);
  assert.deepEqual(readdirSync(join(dir, 'oc_new')), ['b.png']);
});

test('目录不存在（还没人发过附件）不抛错', async () => {
  assert.equal(await pruneMedia(join(root(), 'nope'), 1000, Date.now()), 0);
});
