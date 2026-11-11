// 验收前置闸：做验收/体检前必须先问用户「查哪些维度、用哪个档位」，不许自己猜。
// 提示词层（SYSTEM_BASE 硬规则）+ 工具层（audit_project fail-closed）各测一遍。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import { getSystemPromptParts } from '../desktop/src/main/agent-service.mjs';
import { CORE_DIMENSION_NAMES } from '../src/profile.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function fakePermissions() {
  return {
    noteTarget() {},
    sessionAllowed: () => true,
    commandPrefix: (cmd) => String(cmd).split(/\s+/)[0],
    requestApproval: async () => 'allowed-once'
  };
}

// 带 SQL 拼接的最小项目：真跑 audit 时一定能抓到 S2，便于断言「执行了 / 没执行」
async function makeProject(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-intent-gate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
  await writeFile(path.join(dir, 'app.js'), 'const express=require("express"); const app=express(); app.get("/u",(req,res)=>{ db.query("SELECT * FROM users WHERE id = " + req.query.id); });');
  return dir;
}

test('验收前置闸：无 tier、无 profile → needAsk 且完全不执行 audit', async (t) => {
  const dir = await makeProject(t);
  const archived = [];
  const tools = createAgentTools({
    repoRoot,
    permissions: fakePermissions(),
    recordAudit: async (d, r) => { archived.push({ d, verdict: r.conclusion.verdict }); },
    requireAuditIntent: true
  });
  const out = await tools.audit_project({ dir });
  assert.equal(out.needAsk, true);
  assert.match(out.error, /先确认档位与维度/);
  assert.match(out.error, /ask_user/);
  assert.deepEqual(out.dimensions, [...CORE_DIMENSION_NAMES]);
  assert.equal(out.dimensions.length, 11);
  assert.deepEqual(out.levels, ['L1', 'L2', 'L3']);
  // fail-closed：没有 verdict / findings / gates，也没落项目档案 → audit() 根本没跑
  assert.ok(!('verdict' in out));
  assert.ok(!('findings' in out));
  assert.ok(!('gates' in out));
  assert.equal(archived.length, 0);
});

test('验收前置闸：主 agent（注入 askUser）同样被拦下，不会先跑再看', async (t) => {
  const dir = await makeProject(t);
  const archived = [];
  const tools = createAgentTools({
    repoRoot,
    permissions: fakePermissions(),
    recordAudit: async (d, r) => { archived.push({ d, verdict: r.conclusion.verdict }); },
    askUser: async () => ({ answer: 'L2' })
  });
  const out = await tools.audit_project({ dir });
  assert.equal(out.needAsk, true);
  assert.equal(archived.length, 0);
});

test('验收前置闸：显式 tier → 正常执行（用户已经说清就不重复问）', async (t) => {
  const dir = await makeProject(t);
  const archived = [];
  const tools = createAgentTools({
    repoRoot,
    permissions: fakePermissions(),
    recordAudit: async (d, r) => { archived.push({ d, verdict: r.conclusion.verdict }); },
    requireAuditIntent: true
  });
  const out = await tools.audit_project({ dir, tier: 'L1' });
  assert.ok(!('needAsk' in out));
  assert.ok(typeof out.verdict === 'string' && out.verdict.length > 0);
  assert.ok(Array.isArray(out.findings));
  assert.ok(out.findings.some((f) => f.checkId === 'S2'), '应抓到 SQL 拼接');
  assert.equal(archived.length, 1);
});

test('验收前置闸：项目根有 finalcheck.profile.json → 视为已声明，正常执行', async (t) => {
  const dir = await makeProject(t);
  await writeFile(path.join(dir, 'finalcheck.profile.json'), JSON.stringify({ dimensions: { 安全性: 'L1' } }));
  const archived = [];
  const tools = createAgentTools({
    repoRoot,
    permissions: fakePermissions(),
    recordAudit: async (d, r) => { archived.push({ d, verdict: r.conclusion.verdict }); },
    requireAuditIntent: true
  });
  const out = await tools.audit_project({ dir });
  assert.ok(!('needAsk' in out));
  assert.ok(typeof out.verdict === 'string' && out.verdict.length > 0);
  assert.equal(out.planSource, 'finalcheck.profile.json');
  assert.equal(archived.length, 1);
});

test('验收前置闸：工作流 gate 形态（不传 askUser/requireAuditIntent）保持原行为，不拦', { timeout: 60000 }, async (t) => {
  const dir = await makeProject(t);
  const archived = [];
  const tools = createAgentTools({
    repoRoot,
    permissions: fakePermissions(),
    recordAudit: async (d, r) => { archived.push({ d, verdict: r.conclusion.verdict }); }
  });
  const out = await tools.audit_project({ dir });
  assert.ok(!('needAsk' in out), 'gate 里的 audit_project 不应被验收前置闸拦截');
  assert.ok(typeof out.verdict === 'string' && out.verdict.length > 0);
  assert.equal(archived.length, 1);
});

test('验收前置闸：SYSTEM_BASE 在工具说明之前硬性要求先问档位/维度、不许猜', async () => {
  const { base } = await getSystemPromptParts();
  for (const key of ['先问', '档位', '维度', '不许猜']) {
    assert.ok(base.includes(key), `SYSTEM_BASE 缺少关键短语：${key}`);
  }
  assert.ok(base.includes('必须先调 ask_user'), '应明确要求先调 ask_user');
  const gate = base.indexOf('验收前置（硬规则');
  const toolLine = base.indexOf('工具可用性：');
  const askLine = base.indexOf('向用户提问：');
  assert.ok(gate >= 0, '缺少验收前置硬规则段');
  assert.ok(toolLine >= 0, '缺少工具可用性说明');
  assert.ok(gate < toolLine, '验收前置硬规则必须在工具说明之前');
  assert.ok(gate < askLine, '验收前置硬规则必须排在通用提问说明之前');
  assert.ok(base.includes('不要重复问') && base.includes('用户已经说清'), '应说明用户已说清时不重复问');
  assert.ok(base.includes('多候选不许猜'), '多候选目录必须先问，单独成句');
});
