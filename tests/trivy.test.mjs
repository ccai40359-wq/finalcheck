// Trivy 接入（2026-11-18）：映射、缺口摘除、关闭/失败的 fail-closed 口径，以及 audit 层的分发。
// 全部用注入 runner，不真跑 Trivy（不联网、不依赖本机安装）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mapTrivyResults, runTrivy } from '../src/checks/trivy.mjs';
import { checkDeps } from '../src/checks/deps.mjs';
import { audit } from '../src/audit.mjs';

function project(t, files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-trivy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

// 假密钥运行时拼出来：源码里不出现完整的 AKIA 串（自审与 GitHub push protection 都会拦）
const FAKE_AKIA = ['AKIA', 'IOSFODNN7EXAMPLEXX'].join('');
const GO_MOD = 'module example.com/app\n\ngo 1.20\n\nrequire golang.org/x/net v0.0.0-20220722155237-a158d28d115b\n';
const GO_SUM = 'golang.org/x/net v0.0.0-20220722155237-a158d28d115b h1:x\n';

const SAMPLE = {
  Results: [
    {
      Target: 'go.mod', Class: 'lang-pkgs', Type: 'gomod',
      Vulnerabilities: [
        { VulnerabilityID: 'CVE-2022-27664', PkgName: 'golang.org/x/net', InstalledVersion: 'v0.0.0-2022', FixedVersion: '0.0.0-20220906165146-f3363e06e74c', Severity: 'HIGH' },
        { VulnerabilityID: 'CVE-2023-39325', PkgName: 'golang.org/x/net', InstalledVersion: 'v0.0.0-2022', FixedVersion: '0.17.0', Severity: 'MEDIUM' },
      ],
    },
    { Target: 'package-lock.json', Class: 'lang-pkgs', Type: 'npm', Vulnerabilities: [{ VulnerabilityID: 'CVE-X', PkgName: 'lodash', InstalledVersion: '4.0.0', Severity: 'HIGH' }] },
    {
      Target: 'Dockerfile', Class: 'config', Type: 'dockerfile',
      Misconfigurations: [
        { ID: 'DS-0002', Title: "Image user should not be 'root'", Severity: 'HIGH', Status: 'FAIL', CauseMetadata: { StartLine: 2 } },
        { ID: 'DS-0026', Title: 'No HEALTHCHECK defined', Severity: 'LOW', Status: 'FAIL' },
        { ID: 'DS-0001', Title: 'passed', Severity: 'MEDIUM', Status: 'PASS' },
      ],
    },
    { Target: 'deploy.cfg', Class: 'secret', Secrets: [{ RuleID: 'aws-access-key-id', Title: 'AWS Access Key ID', StartLine: 1, Match: `aws_key = ${FAKE_AKIA}` }] },
  ],
};

test('mapTrivyResults：同包多 CVE 合一条、npm 不重复报、PASS 不报、密钥打码', (t) => {
  const dir = project(t, { 'go.mod': GO_MOD });
  const m = mapTrivyResults(SAMPLE, dir);
  assert.deepEqual([...m.ecosystems], ['go']);
  assert.equal(m.s4.length, 1);
  assert.equal(m.s4[0].severity, 'high');
  assert.equal(m.s4[0].force, 'card');
  assert.equal(m.s4[0].line, 5);
  assert.match(m.s4[0].message, /CVE-2022-27664、CVE-2023-39325/);
  assert.deepEqual(m.o1.map((f) => [f.rule, f.force]), [['O1.trivy-DS-0002', 'check'], ['O1.trivy-DS-0026', 'tip']]);
  assert.equal(m.s3.length, 1);
  assert.equal(m.s3[0].rule, 'S3.trivy-aws-access-key-id');
  assert.ok(!m.s3[0].snippet.includes(FAKE_AKIA), '密钥原文不能进报告');
});

test('runTrivy：FINALCHECK_TRIVY=off / 运行失败 / 输出非 JSON 都返回 ran:false 且带说明', async (t) => {
  const dir = project(t, {});
  const prev = process.env.FINALCHECK_TRIVY;
  process.env.FINALCHECK_TRIVY = 'off';
  t.after(() => { if (prev === undefined) delete process.env.FINALCHECK_TRIVY; else process.env.FINALCHECK_TRIVY = prev; });
  const off = await runTrivy(dir);
  assert.equal(off.ran, false);
  assert.match(off.warnings[0], /已关闭/);

  const failed = await runTrivy(dir, { runner: async () => ({ status: 1, stdout: '', stderr: 'boom' }) });
  assert.equal(failed.ran, false);
  assert.match(failed.warnings[0], /运行失败（boom）/);

  const garbage = await runTrivy(dir, { runner: async () => ({ status: 0, stdout: '{not json' }) });
  assert.equal(garbage.ran, false);
  assert.match(garbage.warnings[0], /无法解析/);

  const ok = await runTrivy(dir, { runner: async (_d, args) => { assert.ok(args.includes('--skip-dirs')); return { status: 0, stdout: JSON.stringify(SAMPLE) }; } });
  assert.equal(ok.ran, true);
  assert.equal(ok.s4.length, 1);
});

test('checkDeps：Trivy 审过的 Go 不再记缺口且带出 S4 发现；没跑 Trivy 时缺口照旧', async (t) => {
  const dir = project(t, { 'go.mod': GO_MOD, 'go.sum': GO_SUM });
  const without = await checkDeps(dir, {});
  assert.match(String(without.coverageGap), /go|Go/);
  assert.equal(without.findings.length, 0);

  const trivy = { ran: true, ...mapTrivyResults(SAMPLE, dir), warnings: [] };
  const withTrivy = await checkDeps(dir, { trivy });
  assert.ok(!withTrivy.coverageGap, `不应再有缺口：${withTrivy.coverageGap}`);
  assert.equal(withTrivy.findings.length, 1);
  assert.equal(withTrivy.findings[0].rule, 'S4.trivy');
  assert.ok(withTrivy.warnings.some((w) => /Trivy 审计/.test(w)));

  // 跑失败（ran:false）不能摘缺口
  const failed = await checkDeps(dir, { trivy: { ran: false, s4: [], ecosystems: new Set(['go']) } });
  assert.match(String(failed.coverageGap), /go|Go/);
});

test('audit：L2 不跑 O1 时，Trivy 配置问题并入 S5；密钥与自研规则同行合并', async (t) => {
  const dir = project(t, {
    'go.mod': GO_MOD, 'go.sum': GO_SUM,
    Dockerfile: 'FROM python:3.8\nUSER root\n',
    'deploy.cfg': `aws_key = ${FAKE_AKIA}\n`,
  });
  const r = await audit(dir, { tier: 'L2', trivyRunner: async () => ({ status: 0, stdout: JSON.stringify(SAMPLE) }) });
  const rules = r.findings.map((f) => f.rule);
  assert.ok(rules.includes('S4.trivy'));
  assert.ok(rules.includes('S5.trivy-DS-0002'));
  assert.ok(!rules.some((x) => x.startsWith('O1.')), 'L2 计划里没有 O1，不该冒出 O1 发现');
  const secret = r.findings.filter((f) => f.file === 'deploy.cfg' && f.line === 1);
  assert.equal(secret.length, 1, '同一行的密钥只报一次');
});
