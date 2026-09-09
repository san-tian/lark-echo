import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { UiServer } from '../src/http.ts';
import type { UiData } from '../src/ui-data.ts';

const TOKEN = 'capability-token-for-test';

const stubData = {
  state: async () => ({ now: Date.now(), daemon: { pid: 1, channel: 'feishu' } }),
  action: async (path: string) => ({ ok: path }),
} as unknown as UiData;

async function startServer() {
  const server = new UiServer({ data: stubData, token: TOKEN, port: 0, idleMs: 60_000 });
  const { url, port } = await server.start();
  return { server, url, port, base: `http://127.0.0.1:${port}` };
}

/** 走一次 token 换 cookie，返回 cookie 与 csrf */
async function login(base: string) {
  const res = await fetch(`${base}/?t=${TOKEN}`, { redirect: 'manual' });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const page = await fetch(`${base}/`, { headers: { cookie } });
  const html = await page.text();
  const csrf = /data-csrf="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf, '页面里应有 csrf token');
  return { cookie, csrf: csrf! };
}

test('无 cookie 访问 → 401', async () => {
  const { server, base } = await startServer();
  const res = await fetch(base + '/');
  assert.equal(res.status, 401);
  await server.close();
});

test('错误的 token 不能换 cookie', async () => {
  const { server, base } = await startServer();
  const res = await fetch(base + '/?t=wrong', { redirect: 'manual' });
  assert.equal(res.status, 401);
  await server.close();
});

test('正确 token 换到 httpOnly cookie（一次性）', async () => {
  const { server, base } = await startServer();
  const res = await fetch(base + '/?t=' + TOKEN, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const cookie = (res.headers.getSetCookie?.() ?? []).join(';');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  await server.close();
});

test('登录后能读 state，且带 CSP 头', async () => {
  const { server, base } = await startServer();
  const { cookie } = await login(base);
  const res = await fetch(base + '/api/state', { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { daemon: { channel: string } };
  assert.equal(body.daemon.channel, 'feishu');
  const page = await fetch(base + '/', { headers: { cookie } });
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  await server.close();
});

test('写操作缺 CSRF → 403', async () => {
  const { server, base } = await startServer();
  const { cookie } = await login(base);
  const res = await fetch(base + '/api/bind', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: 'oc_x' }),
  });
  assert.equal(res.status, 403);
  await server.close();
});

test('写操作带 CSRF → 200', async () => {
  const { server, base } = await startServer();
  const { cookie, csrf } = await login(base);
  const res = await fetch(base + '/api/bind', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ chatId: 'oc_x' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: '/api/bind' });
  await server.close();
});

test('跨站 Origin → 403（防 DNS rebinding / CSRF）', async () => {
  const { server, base } = await startServer();
  const { cookie, csrf } = await login(base);
  const res = await fetch(base + '/api/bind', {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      origin: 'http://evil.example.com',
    },
    body: '{}',
  });
  assert.equal(res.status, 403);
  await server.close();
});

test('非法 Host 头 → 403（防 DNS rebinding）', async () => {
  const { server, port } = await startServer();
  // fetch 会覆盖 Host，必须用原始 http 请求才能伪造 Host
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', headers: { host: 'evil.example.com' } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  await server.close();
});

test('GET 不能触发写操作', async () => {
  const { server, base } = await startServer();
  const { cookie } = await login(base);
  const res = await fetch(base + '/api/bind', { headers: { cookie } });
  assert.equal(res.status, 405);
  await server.close();
});
