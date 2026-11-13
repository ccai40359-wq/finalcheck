// 动态目标执行前的授权闸：非 localhost 必须经审批卡确认；拒绝时不发请求。
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import {
  resetLedger, ensureHostAuthorized, assertHost,
  getLedger
} from '../desktop/src/main/permissions.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

beforeEach(() => { resetLedger(); });
after(() => { resetLedger(); });

test('ensureHostAuthorized: localhost 直接放行，不弹审批', async () => {
  let asked = 0;
  const r = await ensureHostAuthorized('http://127.0.0.1:3000/api', {
    approvalFn: async () => { asked += 1; return 'rejected'; }
  });
  assert.equal(r.ok, true);
  assert.equal(r.host, '127.0.0.1');
  assert.equal(asked, 0);
});

test('ensureHostAuthorized: 外部 host 未确认 → 审批拒绝 → 不写台账、不执行', async () => {
  const r = await ensureHostAuthorized('https://example.com/app', {
    approvalFn: async () => 'rejected'
  });
  assert.equal(r.ok, false);
  assert.equal(r.host, 'example.com');
  assert.match(String(r.error), /未授权/);
  assert.ok(!getLedger().confirmedHosts.includes('example.com'), '拒绝后不能写入确认台账');
});

test('ensureHostAuthorized: 外部 host 经审批允许 → 写入台账，后续 assertHost 放行', async () => {
  const r = await ensureHostAuthorized('https://example.com/app', {
    approvalFn: async () => 'allowed-once'
  });
  assert.equal(r.ok, true);
  assert.ok(getLedger().confirmedHosts.includes('example.com'));
  assert.equal(assertHost('example.com'), 'example.com');
});

test('ensureHostAuthorized: 非法 URL / 非 http(s) 拒绝', async () => {
  assert.equal((await ensureHostAuthorized('not a url')).ok, false);
  assert.equal((await ensureHostAuthorized('ftp://example.com')).ok, false);
});

test('agent-tools probe_target: 外部未授权目标被拒，且不发起探测', async () => {
  resetLedger();
  let approvalCalls = 0;
  const permissions = {
    requestApproval: async () => { approvalCalls += 1; return 'rejected'; },
    ensureHostAuthorized: async (url, opts) => {
      const r = await ensureHostAuthorized(url, { ...opts, approvalFn: permissions.requestApproval });
      return r;
    },
    noteTarget: () => { throw new Error('noteTarget 不应在拒绝路径被调用'); },
    confirmHost: (h) => h
  };
  const tools = createAgentTools({ repoRoot, permissions });
  const r = await tools.probe_target({ url: 'https://example.com' });
  assert.equal(r.deniedBy, 'policy');
  assert.match(String(r.error), /未授权/);
  assert.equal(approvalCalls, 1);
});
