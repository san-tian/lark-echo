import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _migrateDir, insteadHome, migrateLegacyHome } from '../src/paths.ts';

/** 每个用例一个隔离的临时根目录 */
function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'instead-paths-'));
}

/* ---------------------- 改名迁移（DESIGN §1.3.1） ---------------------- */

test('迁移：旧目录存在、新目录不存在 → 搬过去，内容不丢', () => {
  const root = tmpRoot();
  try {
    const legacy = join(root, '.lark-echo');
    const target = join(root, '.instead');
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
    const target = join(root, '.instead');
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
    assert.equal(_migrateDir(join(root, '.lark-echo'), join(root, '.instead')), false);
    assert.equal(existsSync(join(root, '.instead')), false, '不应凭空建出新目录');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* -------- 改过两次名：lark-echo → anylark → instead（DESIGN §1.3.1）-------- */

const ENV_KEYS = ['INSTEAD_HOME', 'ANYLARK_HOME', 'LARK_ECHO_HOME'] as const;

/** 清掉三个 *_HOME，返回还原函数 —— 迁移只在用默认路径时发生 */
function withCleanEnv(fn: () => void): void {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of ENV_KEYS) delete process.env[k];
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('两个旧目录都在时，取较新的 .anylark（.lark-echo 是上一轮迁移的残留）', () => {
  const root = tmpRoot();
  try {
    // 这正是本机的真实处境：.anylark 里是有效状态，.lark-echo 早已被搬空/删除，
    // 但万一两者共存，搬错的那个会让凭据和绑定凭空消失。
    const older = join(root, '.lark-echo');
    const newer = join(root, '.anylark');
    mkdirSync(older, { recursive: true });
    writeFileSync(join(older, 'which.txt'), 'stale');
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(newer, 'which.txt'), 'live');

    const target = join(root, '.instead');
    // 复刻 migrateLegacyHome 的顺序：.anylark 优先
    let moved = false;
    for (const dir of ['.anylark', '.lark-echo']) {
      if (_migrateDir(join(root, dir), target)) {
        moved = true;
        break;
      }
    }
    assert.equal(moved, true);
    assert.equal(readFileSync(join(target, 'which.txt'), 'utf8'), 'live', '必须搬 .anylark');
    assert.equal(existsSync(older), true, '.lark-echo 留在原地，不动它');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('显式设了任一 *_HOME 就完全听环境变量，不做迁移', () => {
  const root = tmpRoot();
  try {
    for (const key of ENV_KEYS) {
      withCleanEnv(() => {
        process.env[key] = join(root, 'explicit');
        assert.equal(migrateLegacyHome(), false, `设了 ${key} → 不该迁移真实 home`);
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------- 环境变量优先级 ------------------------- */

test('新变量优先，两个旧变量仍兼容读取', () => {
  withCleanEnv(() => {
    process.env.INSTEAD_HOME = '/tmp/h-new';
    process.env.ANYLARK_HOME = '/tmp/h-mid';
    process.env.LARK_ECHO_HOME = '/tmp/h-old';
    assert.equal(insteadHome(), '/tmp/h-new', 'INSTEAD_HOME 最优先');

    delete process.env.INSTEAD_HOME;
    assert.equal(insteadHome(), '/tmp/h-mid', '退到 ANYLARK_HOME');

    delete process.env.ANYLARK_HOME;
    assert.equal(insteadHome(), '/tmp/h-old', '再退到 LARK_ECHO_HOME');

    delete process.env.LARK_ECHO_HOME;
    assert.match(insteadHome(), /\.instead$/, '都不设时落到 ~/.instead');
  });
});
