import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockingServers, lazyServers, readMcpServers } from '../src/mcp-config.ts';

function fakeHome(globalServers: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'le-home-'));
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(join(home, '.pi', 'agent', 'mcp.json'), JSON.stringify({ mcpServers: globalServers }));
  return home;
}

test('默认（无 lifecycle）= lazy；显式 eager 才是 eager', () => {
  const home = fakeHome({
    a: { command: 'x' },
    b: { command: 'y', lifecycle: 'eager' },
    c: { command: 'z', lifecycle: 'lazy' },
  });
  const servers = readMcpServers('/nonexistent', home);
  assert.deepEqual(lazyServers(servers).sort(), ['a', 'c']);
  assert.deepEqual(blockingServers(servers), []);
});

test('eager + OAuth 会被标为阻塞启动的 server（spike 1）', () => {
  const home = fakeHome({
    'remote-mcp': { url: 'https://x/mcp', lifecycle: 'eager', auth: { type: 'oauth' } },
  });
  const servers = readMcpServers('/nonexistent', home);
  assert.deepEqual(blockingServers(servers), ['remote-mcp']);
});

test('项目级 mcp.json 按 key 覆盖全局', () => {
  const home = fakeHome({ a: { command: 'global', lifecycle: 'eager' } });
  const cwd = mkdtempSync(join(tmpdir(), 'le-cwd-'));
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(
    join(cwd, '.pi', 'mcp.json'),
    JSON.stringify({ mcpServers: { a: { command: 'project', lifecycle: 'lazy' } } }),
  );
  const servers = readMcpServers(cwd, home);
  assert.equal(servers.a?.command, 'project');
  assert.deepEqual(lazyServers(servers), ['a']);
});

test('配置缺失/损坏时不抛错', () => {
  const home = mkdtempSync(join(tmpdir(), 'le-home-'));
  assert.deepEqual(readMcpServers('/nonexistent', home), {});
});
