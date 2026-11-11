import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { applyAcceptances, lineFingerprint } from '../src/accept.mjs';

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-accept-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// 合成密钥在运行时拼接，源码里不写完整密钥字面量（避免本测试自己触发 S3）。
const FAKE_KEY = ['sk', 'live', 'synthetic', 'test', 'key'].join('-');
const ORIGINAL_LINE = `const apiKey = '${FAKE_KEY}';`;
const CHANGED_LINE = `const apiKey = '${['sk', 'live', 'different', 'key', '999'].join('-')}';`;

async function fixture(dir, lineText = ORIGINAL_LINE) {
  await mkdir(path.join(dir, 'tests'), { recursive: true });
  await writeFile(path.join(dir, 'tests', 'synthetic.test.mjs'), `// fixture\n${lineText}\n`);
  return lineText;
}

function finding() {
  return {
    checkId: 'S3',
    severity: 'high',
    force: 'card',
    file: 'tests/synthetic.test.mjs',
    line: 2,
    rule: 'S3.secret-literal',
    snippet: 'const apiKey = ***',
    message: 'synthetic fixture',
    source: 'program',
  };
}

async function accept(dir, entry) {
  await mkdir(path.join(dir, '.finalcheck'), { recursive: true });
  await writeFile(path.join(dir, '.finalcheck', 'accept.json'), JSON.stringify({ entries: [entry] }, null, 2));
}

function makeEntry(dir, overrides = {}) {
  return {
    rule: 'S3.secret-literal',
    file: 'tests/synthetic.test.mjs',
    line: 2,
    hash: '',
    reason: '测试用合成密钥，不是真实凭据',
    expires: '2027-01-01',
    ...overrides,
  };
}

test('accept: 命中 rule+file+line+行指纹 → 不报，且豁免清单可审计', async (t) => {
  const dir = await tmp(t);
  const text = await fixture(dir);
  await accept(dir, makeEntry(dir, { hash: lineFingerprint(text) }));
  const res = await applyAcceptances(dir, [finding()]);
  assert.equal(res.findings.length, 0, 'matching acceptance must suppress the finding');
  assert.equal(res.accepted.length, 1);
  assert.equal(res.accepted[0].file, 'tests/synthetic.test.mjs');
  assert.equal(res.accepted[0].line, 2);
  assert.equal(res.accepted[0].reason, '测试用合成密钥，不是真实凭据');
  assert.ok(res.warnings.some((w) => w.includes('已豁免') && w.includes('tests/synthetic.test.mjs:2')), 'accepted entry must be visible in warnings');
});

test('accept: 该行内容改过 → 豁免失效并仍报（防止盖住新密钥）', async (t) => {
  const dir = await tmp(t);
  const text = await fixture(dir);
  await accept(dir, makeEntry(dir, { hash: lineFingerprint(text) }));
  await fixture(dir, CHANGED_LINE);
  const res = await applyAcceptances(dir, [finding()]);
  assert.equal(res.findings.length, 1, 'changed line must be reported again');
  assert.equal(res.accepted.length, 0);
  assert.ok(res.warnings.some((w) => w.includes('行内容已变')), 'stale acceptance must be surfaced');
});

test('accept: expires 已过 → 豁免失效并仍报', async (t) => {
  const dir = await tmp(t);
  const text = await fixture(dir);
  await accept(dir, makeEntry(dir, { hash: lineFingerprint(text), expires: '2000-01-01' }));
  const res = await applyAcceptances(dir, [finding()], { now: new Date('2026-11-11T00:00:00Z') });
  assert.equal(res.findings.length, 1, 'expired acceptance must not suppress');
  assert.equal(res.accepted.length, 0);
  assert.ok(res.warnings.some((w) => w.includes('豁免已过期')), 'expired acceptance must be surfaced');
});

test('accept: 缺少行指纹/文件不存在/JSON 损坏一律 fail closed，并给出警告', async (t) => {
  const dir = await tmp(t);
  const text = await fixture(dir);
  await accept(dir, makeEntry(dir, { hash: '' }));
  const res = await applyAcceptances(dir, [finding()]);
  assert.equal(res.findings.length, 1, 'missing hash must not suppress');
  assert.ok(res.warnings.some((w) => w.includes('行指纹')), 'invalid hash must be surfaced');

  await accept(dir, makeEntry(dir, { hash: lineFingerprint(text), file: 'tests/nope.test.mjs' }));
  const res2 = await applyAcceptances(dir, [finding()]);
  assert.equal(res2.findings.length, 1, 'file mismatch must not suppress');

  await writeFile(path.join(dir, '.finalcheck', 'accept.json'), '{ bad json');
  const res3 = await applyAcceptances(dir, [finding()]);
  assert.equal(res3.findings.length, 1, 'broken accept.json must not suppress');
  assert.ok(res3.warnings.some((w) => w.includes('不是合法 JSON')));
});
