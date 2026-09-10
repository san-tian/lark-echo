import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UiData } from '../src/ui-data.ts';

/** listSessions 只碰文件系统，不用真的 db/channel/pool */
const data = new UiData({} as never);

function withCodexHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'instead-codex-'));
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  return fn(home).finally(() => {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });
}

/** 造一个 rollout：首行是 session meta，padBytes 控制它有多长 */
function writeRollout(home: string, threadId: string, cwd: string, padBytes = 0): void {
  const dir = join(home, 'sessions', '2026', '09', '10');
  mkdirSync(dir, { recursive: true });
  const meta = {
    timestamp: '2026-09-10T10:00:00.000Z',
    type: 'session_meta',
    payload: { session_id: threadId, cwd, instructions: 'x'.repeat(padBytes) },
  };
  writeFileSync(
    join(dir, `rollout-2026-09-10T10-00-00-${threadId}.jsonl`),
    JSON.stringify(meta) + '\n' + JSON.stringify({ ordinal: 1, type: 'event_msg' }) + '\n',
  );
}

const ID_A = '01a0f000-0000-7000-8000-00000000000a';
const ID_B = '01a0f000-0000-7000-8000-00000000000b';

test('codex：按 rollout 首行的 cwd 筛出会话（路径里没有 cwd）', async () => {
  await withCodexHome(async (home) => {
    writeRollout(home, ID_A, '/want');
    writeRollout(home, ID_B, '/other');
    const list = await data.listSessions('codex', '/want');
    assert.deepEqual(
      list.map((s) => s.sessionId),
      [ID_A],
      '只应返回 cwd 匹配的那条',
    );
  });
});

test('codex：首行远超单次读取长度时也要认出来', async () => {
  // 回归：原实现用固定 4 KiB buffer 读首行，实测 session meta 能到 ~23 KB。
  // 截断后 JSON.parse 抛错，被 catch 成 undefined，与「cwd 不匹配」撞成同一个
  // 结果 —— 于是 codex 的会话列表永远是空的，用户无从接管已有会话。
  await withCodexHome(async (home) => {
    writeRollout(home, ID_A, '/want', 40_000);
    const list = await data.listSessions('codex', '/want');
    assert.deepEqual(list.map((s) => s.sessionId), [ID_A], '长首行不能被当成不匹配');
  });
});

test('codex：畸形首行只影响那一条，不拖垮整个列表', async () => {
  await withCodexHome(async (home) => {
    const dir = join(home, 'sessions', '2026', '09', '10');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-09-10T09-00-00-${ID_B}.jsonl`), 'not json\n');
    writeRollout(home, ID_A, '/want');
    const list = await data.listSessions('codex', '/want');
    assert.deepEqual(list.map((s) => s.sessionId), [ID_A]);
  });
});

test('codex：没有 CODEX_HOME 也不抛', async () => {
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(tmpdir(), 'instead-nonexistent-' + Date.now());
  try {
    assert.deepEqual(await data.listSessions('codex', '/want'), []);
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
});
