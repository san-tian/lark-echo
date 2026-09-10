import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { UiData, UiPathError, expandHome, fsRoots, resolveBrowsePath } from '../src/ui-data.ts';

/** listDirs 只碰文件系统，不用真的 db/channel/pool */
const data = new UiData({} as never);

/** 把可浏览的根临时改成 tmpdir，好在里面造目录结构 */
function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'instead-ui-fs-'));
  const saved = process.env.INSTEAD_FS_ROOTS;
  process.env.INSTEAD_FS_ROOTS = root;
  return fn(root).finally(() => {
    if (saved === undefined) delete process.env.INSTEAD_FS_ROOTS;
    else process.env.INSTEAD_FS_ROOTS = saved;
    rmSync(root, { recursive: true, force: true });
  });
}

const isCode = (code: string) => (err: unknown): boolean =>
  err instanceof UiPathError && err.code === code;

test('列出子目录（只列目录、按名字排序），并给出上一级', async () => {
  await withRoot(async (root) => {
    mkdirSync(join(root, 'b'));
    mkdirSync(join(root, 'a'));
    writeFileSync(join(root, 'file.txt'), 'x');
    const listing = await data.listDirs(root);
    assert.deepEqual(
      listing.dirs.map((d) => d.name),
      ['a', 'b'],
      '文件不该混进来',
    );
    assert.equal(listing.path, root);
    assert.equal(listing.parent, undefined, '根本身没有上一级 —— 免得导航出根');
  });
});

test('子目录能给出 parent', async () => {
  await withRoot(async (root) => {
    mkdirSync(join(root, 'a'));
    const listing = await data.listDirs(join(root, 'a'));
    assert.equal(listing.parent, root);
  });
});

test('手输路径不存在：明确报错，而不是静默退回根目录', async () => {
  await withRoot(async (root) => {
    await assert.rejects(() => data.listDirs(join(root, 'nope')), isCode('not_found'));
  });
});

test('手输一个文件：报「不是目录」', async () => {
  await withRoot(async (root) => {
    writeFileSync(join(root, 'file.txt'), 'x');
    await assert.rejects(() => data.listDirs(join(root, 'file.txt')), isCode('not_a_dir'));
  });
});

test('根之外的路径一律拒绝（配置台不该变成任意路径浏览器）', async () => {
  await withRoot(async (root) => {
    await assert.rejects(() => data.listDirs('/etc'), isCode('outside_roots'));
    await assert.rejects(() => data.listDirs(join(root, '..')), isCode('outside_roots'), '.. 也不行');
  });
});

test('resolveBrowsePath：空输入给第一个根，~ 展开，越界报错', () => {
  const roots = ['/home/dev'];
  assert.equal(resolveBrowsePath(undefined, roots), '/home/dev');
  assert.equal(resolveBrowsePath('   ', roots), '/home/dev');
  assert.equal(resolveBrowsePath('~/RSI', roots), '/home/dev/RSI');
  assert.equal(resolveBrowsePath('/home/dev/instead/../RSI', roots), '/home/dev/RSI');
  assert.throws(() => resolveBrowsePath('/etc', roots), isCode('outside_roots'));
  assert.throws(() => resolveBrowsePath('/home/devil', roots), isCode('outside_roots'), '前缀像但不是子路径');
});

test('expandHome / fsRoots', () => {
  assert.equal(expandHome('~', '/home/dev'), '/home/dev');
  assert.equal(expandHome('~/a/b', '/home/dev'), '/home/dev/a/b');
  assert.equal(expandHome('a/b', '/home/dev'), 'a/b', '相对路径不在这里展开');
  assert.deepEqual(fsRoots({} as unknown as NodeJS.ProcessEnv), [homedir()]);
  assert.deepEqual(
    fsRoots({ INSTEAD_FS_ROOTS: '/srv/a:/srv/b' } as unknown as NodeJS.ProcessEnv),
    ['/srv/a', '/srv/b'],
  );
  assert.deepEqual(
    fsRoots({ INSTEAD_FS_ROOTS: '  ' } as unknown as NodeJS.ProcessEnv),
    [homedir()],
    '空值 = 默认',
  );
});
