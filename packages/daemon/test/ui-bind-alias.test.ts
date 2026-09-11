import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '@instead/core';
import { getSessionAlias, setSessionAlias } from '@instead/core';
import { upsertResumeAlias } from '../src/ui-data.ts';

const db = (): ReturnType<typeof openDb> => openDb(':memory:');

test('pi：resumeExisting 写自指别名（无害且更明确）', () => {
  const d = db();
  upsertResumeAlias(d, 'pi', '01a0-aaa');
  assert.equal(getSessionAlias(d, '01a0-aaa'), '01a0-aaa');
});

test('opaque 没有别名：写自指（UI 从列表选的本来就是真实 id）', () => {
  const d = db();
  upsertResumeAlias(d, 'codex', '01a086e8-thread');
  assert.equal(getSessionAlias(d, '01a086e8-thread'), '01a086e8-thread');
});

test('opaque 已有学到的真实 id：不覆盖（覆盖会让 resume 指向不存在的 thread）', () => {
  const d = db();
  setSessionAlias(d, 'codex-test', 'codex', '01a086e8-thread');
  upsertResumeAlias(d, 'codex', 'codex-test');
  assert.equal(getSessionAlias(d, 'codex-test'), '01a086e8-thread', '学到的真实 id 必须保留');
});
