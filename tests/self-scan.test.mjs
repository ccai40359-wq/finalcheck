import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInject } from '../src/checks/inject.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'scripts', 'e2e-smoke.mjs');

// 回归：我们自己的 e2e 脚本里，表名只做白名单比对，SQL 必须是固定字面量。
// 曾经写成 "SELECT COUNT(*) FROM " + table，被自家 S2 判成高危拼接 SQL。
test('self-scan: e2e-smoke 的 SQL 不做字符串拼接（S2 零命中）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-self-scan-'));
  try {
    await copyFile(script, path.join(dir, 'e2e-smoke.mjs'));
    const r = await checkInject(dir, { tier: 'L3' });
    assert.deepEqual(r.findings.filter((f) => f.rule === 'S2.sqli-concat'), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
