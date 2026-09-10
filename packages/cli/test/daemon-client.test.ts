import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcServer } from '@instead/daemon';
import { createLogger, setLogSink } from '@instead/core';
import { pingDaemon, withDaemon } from '../src/daemon-client.ts';

// IpcServer 会把 handler 抛的错记成 warn —— 本测试故意制造这些错，静音掉
setLogSink(() => {});
const quiet = createLogger({ svc: 'test' });

async function withServer(
  handler: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  fn: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'instead-ipc-'));
  const socketPath = join(dir, 'd.sock');
  const server = new IpcServer(socketPath, handler, quiet);
  await server.listen();
  try {
    await fn(socketPath);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('daemon 不在 → undefined（允许调用方退化成直接写库）', async () => {
  const missing = join(tmpdir(), 'instead-nonexistent-' + Date.now() + '.sock');
  const res = await withDaemon((c) => c.call('ping'), missing);
  assert.equal(res, undefined);
});

test('daemon 在且调用成功 → 返回结果', async () => {
  await withServer(
    async (method) => (method === 'ping' ? { pid: 4242 } : null),
    async (socketPath) => {
      const res = await withDaemon((c) => c.call<{ pid: number }>('ping'), socketPath);
      assert.deepEqual(res, { pid: 4242 });
    },
  );
});

test('daemon 在但调用失败 → 抛出，绝不静默退化', async () => {
  // 这是核心回归点：之前 withIpc 把「连不上」和「调用失败」都吞成 undefined，
  // 于是 bind 会在 daemon 活着的时候绕过它直接写库，两边状态就此分叉。
  await withServer(
    async () => {
      throw new Error('chat oc_x 已绑定 session s1');
    },
    async (socketPath) => {
      await assert.rejects(
        () => withDaemon((c) => c.call('bind.add', { chatId: 'oc_x' }), socketPath),
        /已绑定 session s1/,
        '必须把 daemon 的错误原样抛出来',
      );
    },
  );
});

test('pingDaemon 把调用失败也算作「不活」，不抛', async () => {
  await withServer(
    async () => {
      throw new Error('boom');
    },
    async (socketPath) => {
      assert.equal(await pingDaemon(socketPath), undefined);
    },
  );
});

test('pingDaemon 在 daemon 健康时返回 pid', async () => {
  await withServer(
    async () => ({ pid: 99 }),
    async (socketPath) => {
      assert.deepEqual(await pingDaemon(socketPath), { pid: 99 });
    },
  );
});
