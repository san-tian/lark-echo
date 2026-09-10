import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../src/index.ts';

const page = (): string => renderPage({ csrf: 'csrf-token-abc', nonce: 'nonce-xyz' });

/* ------------------------------ 安全相关 ------------------------------ */

test('csrf token 注入到 body 的 data 属性', () => {
  assert.match(page(), /data-csrf="csrf-token-abc"/);
});

test('每个 <script>/<style> 都带 nonce（CSP 要求）', () => {
  const html = page();
  const tags = html.match(/<(script|style)\b[^>]*>/g) ?? [];
  assert.ok(tags.length >= 2, `应至少有 script 与 style，实到 ${tags.length}`);
  for (const tag of tags) {
    assert.match(tag, /nonce="nonce-xyz"/, `缺 nonce: ${tag}`);
  }
});

test('不含外链资源（CSP 只允许 self + nonce）', () => {
  const html = page();
  assert.equal(/<script[^>]+src=/.test(html), false, '不应有外链 script');
  assert.equal(/<link[^>]+href="https?:/.test(html), false, '不应有外链样式');
});

/* ------------------------------ 改名残留 ------------------------------ */

test('页面里没有旧名残留', () => {
  assert.equal(/lark-echo|Lark Echo/i.test(page()), false);
});

/* ---------------------------- 客户端脚本自洽 ---------------------------- */

/** 取出内联脚本正文 */
function clientScript(html: string): string {
  const m = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  assert.ok(m, '找不到内联脚本');
  return m[1]!;
}

test('客户端脚本语法合法', () => {
  const js = clientScript(page());
  assert.doesNotThrow(() => new Function(js), '客户端 JS 有语法错误');
});

test('每个 patch() 目标 id 在 HTML 里真实存在', () => {
  // 差量渲染靠 id 找挂载点；打错一个字就静默不更新，这里兜住
  const html = page();
  const ids = [...clientScript(html).matchAll(/patch\('([a-z-]+)'/g)].map((m) => m[1]!);
  assert.ok(ids.length > 0, '没找到 patch 调用');
  const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `patch 目标缺失: ${missing.join(', ')}`);
});

/* ------------------------------ 可访问性 ------------------------------ */

test('toasts 容器有 aria-live，屏幕阅读器能播报', () => {
  assert.match(page(), /id="toasts"[^>]*aria-live="polite"/);
});

test('每个 <select> 都有可访问名（label for 或 aria-label）', () => {
  const html = page();
  const selects = html.match(/<select\b[^>]*>/g) ?? [];
  assert.ok(selects.length > 0, '页面应有下拉');
  for (const s of selects) {
    const id = s.match(/id="([^"]+)"/)?.[1];
    const named =
      /aria-label="/.test(s) || (id !== undefined && html.includes(`for="${id}"`));
    assert.ok(named, `下拉缺可访问名: ${s}`);
  }
});

test('.sr-only 有定义（表头靠它对屏幕阅读器可见）', () => {
  assert.match(page(), /\.sr-only\s*\{/);
});

test('尊重 prefers-reduced-motion', () => {
  assert.match(page(), /@media\s*\(prefers-reduced-motion/);
});

/* ------------------------------ 渲染稳定性 ------------------------------ */

test('同样输入渲染结果一致（差量比对依赖这点）', () => {
  const a = renderPage({ csrf: 'c', nonce: 'n' });
  const b = renderPage({ csrf: 'c', nonce: 'n' });
  assert.equal(a, b, '渲染必须是纯函数，否则每轮轮询都会误判成有变化');
});

test('nonce 变化只影响 nonce 属性，不影响结构', () => {
  const a = renderPage({ csrf: 'c', nonce: 'n1' }).replaceAll('n1', 'N');
  const b = renderPage({ csrf: 'c', nonce: 'n2' }).replaceAll('n2', 'N');
  assert.equal(a, b);
});
