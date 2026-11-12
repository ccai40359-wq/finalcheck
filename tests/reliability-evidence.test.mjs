import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { conclude } from '../src/audit.mjs';
import { checkQ1, parseCoverageSummaryText } from '../src/checks/q1.mjs';
import { checkQuality } from '../src/checks/quality.mjs';
import { evidenceMatrix } from '../src/profile.mjs';
import { recordProbe, recordStress, dynamicRuntime, resetDynamicEvidence } from '../desktop/src/main/dynamic-evidence.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fc-reliability-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'unused' } }));
  return root;
}
const cov = JSON.stringify({ total: { lines: { pct: 100, covered: 1, total: 1 } } });

test('unresolved manual high/medium findings prevent overall L2/L3 pass', () => {
  for (const tier of ['L2', 'L3']) {
    assert.notEqual(conclude(tier, [{ checkId: 'S7', severity: 'high', force: 'check' }]).verdict, '过');
  }
  assert.equal(conclude('L1', [{ checkId: 'S7', severity: 'high', force: 'check' }]).verdict, '过');
});

test('mandatory quality metric missing is a failed check; optional metric remains advisory', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'finalcheck.quality.json'), JSON.stringify({ checks: [{ id: 'cover', command: 'unused', minPercent: 80 }] }));
  const runner = async () => ({ code: 0, ms: 1, out: 'all passed without measurement', err: '' });
  const result = await checkQuality(root, { tier: 'L3', runner });
  assert.ok(result.findings.some((f) => f.rule === 'Q2.cover-coverage-missing'));
  await writeFile(path.join(root, 'finalcheck.quality.json'), JSON.stringify({ checks: [{ id: 'cover', command: 'unused', minPercent: 80, maxMs: 0.5, expect: '^different output$', optional: true }] }));
  assert.equal((await checkQuality(root, { tier: 'L3', runner })).findings.length, 0);
});

test('Q1 rejects an unchanged coverage artifact and accepts one produced in this invocation', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'coverage'));
  const artifact = path.join(root, 'coverage/coverage-summary.json');
  await writeFile(artifact, cov);
  const stale = await checkQ1(root, { tier: 'L3', testRunner: async () => ({ status: 0 }) });
  assert.match(stale.coverageGap, /本轮|陈旧/);
  await rm(artifact);
  const fresh = await checkQ1(root, { tier: 'L3', testRunner: async () => { await writeFile(artifact, cov); return { status: 0 }; } });
  assert.equal(fresh.coverageGap, null);
  for (const pct of [-1, 101]) assert.ok(parseCoverageSummaryText(JSON.stringify({ total: { lines: { pct, covered: 1, total: 1 } } })).error);
});

test('dynamic evidence is isolated by target, session/project and successful samples', () => {
  resetDynamicEvidence();
  const scope = { sessionId: 'one', projectPath: process.cwd() };
  const url = 'http://127.0.0.1:3000/app';
  recordProbe(url, { ...scope, ok: false, samples: 0 });
  assert.equal(dynamicRuntime({ ...scope, url }).probe.length, 0);
  recordProbe(url, { ...scope, ok: true, samples: 3 });
  assert.equal(dynamicRuntime({ ...scope, url }).probe.length, 1);
  for (const query of [{ ...scope, url: 'http://127.0.0.1:4000/app' }, { ...scope, url: 'http://127.0.0.1:3000/other' }, { ...scope, sessionId: 'two', url }]) {
    assert.equal(dynamicRuntime(query).probe.length, 0);
  }
  const profile = { sources: { code: '.', url, dynamicAuth: true } };
  assert.equal(evidenceMatrix(profile, dynamicRuntime({ ...scope, url })).性能.level, 'static-only');
  recordStress(url, { ...scope, ok: true, samples: 100 });
  assert.equal(evidenceMatrix(profile, dynamicRuntime({ ...scope, url })).性能.level, 'full');
  resetDynamicEvidence();
});
