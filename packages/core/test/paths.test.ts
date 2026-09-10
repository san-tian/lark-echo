import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _migrateDir, anylarkHome, migrateLegacyHome } from '../src/paths.ts';

/** 每个用例一个隔离的临时根目录 */
function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'anylark-paths-'));
}

/* ---------------------- 改名迁移（DESIGN §1.3.1） ---------------------- */

test('迁移：旧目录存在、新目录不存在 → 搬过去，内容不丢', () => {
  const root = tmpRoot();
  try {
    const legacy = join(root, '.lark-echo');
    const target = join(root, '.anylark');
    mkdirSync(join(legacy, 'feishu'), { recursive: true });
    writeFileSync(join(legacy, 'feishu', 'cli_x.json'), '{"appId":"cli_x"}');
    writeFileSync(join(legacy, 'state.db'), 'sqlite');

    assert.equal(_migrateDir(legacy, target), true);
    assert.equal(existsSync(legacy), false, '旧目录应已不存在');
    assert.equal(
      readFileSync(join(target, 'feishu', 'cli_x.json'), 'utf8'),
      '{"appId":"cli_x"}',
      '凭据必须原样搬过去',
    );
    assert.equal(readFileSync(join(target, 'state.db'), 'utf8'), 'sqlite');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('迁移是幂等的：新目录已存在就不动任何东西', () => {
  const root = tmpRoot();
  try {
    const legacy = join(root, '.lark-echo');
    const target = join(root, '.anylark');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'old.txt'), 'old');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'new.txt'), 'new');

    assert.equal(_migrateDir(legacy, target), false, '新目录已存在 → 不迁移');
    assert.equal(existsSync(join(legacy, 'old.txt')), true, '旧目录应保持原样');
    assert.equal(readFileSync(join(target, 'new.txt'), 'utf8'), 'new', '新目录不能被覆盖');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('迁移：旧目录不存在 → 什么都不做（全新安装）', () => {
  const root = tmpRoot();
  try {
    assert.equal(_migrateDir(join(root, '.lark-echo'), join(root, '.anylark')), false);
    assert.equal(existsSync(join(root, '.anylark')), false, '不应凭空建出新目录');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('显式设了 *_HOME 就完全听环境变量，不做迁移', () => {
  const saved = { a: process.env.ANYLARK_HOME, l: process.env.LARK_ECHO_HOME };
  const root = tmpRoot();
  try {
    process.env.ANYLARK_HOME = join(root, 'explicit');
    delete process.env.LARK_ECHO_HOME;
    assert.equal(migrateLegacyHome(), false, '设了 ANYLARK_HOME → 不迁移真实 home');

    delete process.env.ANYLARK_HOME;
    process.env.LARK_ECHO_HOME = join(root, 'legacy-explicit');
    assert.equal(migrateLegacyHome(), false, '设了 LARK_ECHO_HOME → 同样不迁移');
  } finally {
    if (saved.a === undefined) delete process.env.ANYLARK_HOME;
    else process.env.ANYLARK_HOME = saved.a;
    if (saved.l === undefined) delete process.env.LARK_ECHO_HOME;
    else process.env.LARK_ECHO_HOME = saved.l;
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------- 环境变量优先级 ------------------------- */

test('ANYLARK_HOME 优先于 LARK_ECHO_HOME（兼容读取但不夺权）', () => {
  const saved = { a: process.env.ANYLARK_HOME, l: process.env.LARK_ECHO_HOME };
  try {
    process.env.ANYLARK_HOME = '/tmp/new-home';
    process.env.LARK_ECHO_HOME = '/tmp/old-home';
    assert.equal(anylarkHome(), '/tmp/new-home');

    delete process.env.ANYLARK_HOME;
    assert.equal(anylarkHome(), '/tmp/old-home', '只设旧变量时仍要认');

    delete process.env.LARK_ECHO_HOME;
    assert.match(anylarkHome(), /\.anylark$/, '都不设时落到 ~/.anylark');
  } finally {
    if (saved.a === undefined) delete process.env.ANYLARK_HOME;
    else process.env.ANYLARK_HOME = saved.a;
    if (saved.l === undefined) delete process.env.LARK_ECHO_HOME;
    else process.env.LARK_ECHO_HOME = saved.l;
  }
});
