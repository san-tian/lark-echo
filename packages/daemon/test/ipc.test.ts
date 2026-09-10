import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcClient, IpcServer } from '../src/ipc.ts';

const sock = () => join(mkdtempSync(join(tmpdir(), 'anylark-ipc-')), 'd.sock');

test('IPC 请求/响应往返', async () => {
  const path = sock();
  const server = new IpcServer(path, async (method, params) => {
    if (method === 'echo') return { got: params.value };
    throw new Error('boom');
  });
  await server.listen();
  const client = await IpcClient.connect(path);
  assert.deepEqual(await client.call('echo', { value: 42 }), { got: 42 });
  await assert.rejects(() => client.call('nope'), /boom/);
  client.close();
  await server.close();
});

test('IPC 并发请求按 id 正确配对', async () => {
  const path = sock();
  const server = new IpcServer(path, async (method, params) => {
    await new Promise((r) => setTimeout(r, Number(params.delay ?? 0)));
    return { method, n: params.n };
  });
  await server.listen();
  const client = await IpcClient.connect(path);
  const results = await Promise.all([
    client.call('a', { n: 1, delay: 20 }),
    client.call('b', { n: 2, delay: 0 }),
    client.call('c', { n: 3, delay: 10 }),
  ]);
  assert.deepEqual(results, [
    { method: 'a', n: 1 },
    { method: 'b', n: 2 },
    { method: 'c', n: 3 },
  ]);
  client.close();
  await server.close();
});
