import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planHost } from '../src/ui-host.ts';

test('没有 tailnet 时绑 loopback，白名单为空', () => {
  assert.deepEqual(planHost(undefined, {}), { host: '127.0.0.1', allowHosts: [] });
});

test('有 tailnet 时默认绑 tailnet，IP 与 MagicDNS 名都进白名单（决策 20）', () => {
  assert.deepEqual(planHost(undefined, { ip: '100.64.0.1', dnsName: 'box.tail1234.ts.net' }), {
    host: '100.64.0.1',
    allowHosts: ['100.64.0.1', 'box.tail1234.ts.net'],
  });
});

test('有 tailnet IP 但没 MagicDNS 名', () => {
  assert.deepEqual(planHost(undefined, { ip: '100.64.0.1' }), {
    host: '100.64.0.1',
    allowHosts: ['100.64.0.1'],
  });
});

test('显式 --host 覆盖 tailnet', () => {
  assert.deepEqual(planHost('10.0.0.5', { ip: '100.64.0.1', dnsName: 'box.ts.net' }), {
    host: '10.0.0.5',
    allowHosts: ['10.0.0.5'],
  });
});

test('显式 loopback 不进白名单（Host 头本来就允许）', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1']) {
    assert.deepEqual(planHost(h, {}), { host: h, allowHosts: [] }, h);
  }
});

test('显式非 loopback 必须进白名单，否则会被 DNS rebinding 防护 403', () => {
  const plan = planHost('box.local', {});
  assert.deepEqual(plan.allowHosts, ['box.local']);
});
