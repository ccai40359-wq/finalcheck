// 0.34.1 回归测试：
//   ① full access 下越界不再问用户（私钥/项目外/删项目外直接放行）
//   ② full 下仍然必须问的：CU 授权 / 真 Edge / 灾难黑名单（不受影响）
//   ③ 提问与回合结束时的任务栏提醒（红点 + 气泡音，Windows-only，其他平台静默）
//   ④ @ 会话引用：@session:<id> 展开成完整对话记录；手打 @路径 仍然可用
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentTools, resetPolicyGrants, policyGrantKey } from '../desktop/src/main/agent-tools.mjs';
import { createPolicy, checkCommand } from '../desktop/src/main/policy.mjs';
import { expandMentions, findMentions } from '../desktop/src/main/mentions.mjs';
import * as permissions from '../desktop/src/main/permissions.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function tmp(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function setup(t) {
  const project = tmp(t, 'fc-0341-proj-');
  const home = tmp(t, 'fc-0341-home-');
  const outside = tmp(t, 'fc-0341-out-');
  fs.mkdirSync(path.join(home, '.ssh'));
  const key = path.join(home, '.ssh', 'deploy_key');
  fs.writeFileSync(key, 'PRIVATE\n');
  fs.writeFileSync(path.join(outside, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(outside, 'b.txt'), 'b\n');
  return { project, home, outside, key };
}

function tools(project, home, { answers = [], sessionId = 's-0341' } = {}) {
  const asked = [];
  const ts = createAgentTools({
    repoRoot, projectPath: project, sessionId,
    policy: createPolicy({ projectPath: project, mode: 'workspace', home }),
    permissions: {
      requestApproval: async () => 'allowed-once',
      sessionAllowed: () => false,
      getMode: () => permissions.getMode()
    },
    recordAudit: async () => {},
    askUser: answers === null ? null : async (card) => { asked.push(card); return { ok: true, answer: answers.shift() ?? '不允许' }; }
  });
  return { ts, asked };
}

/* ================= ① full access 下越界不问 ================= */

test('0.34.1 ①: full access 下读私钥不再问用户（直接放行）', async (t) => {
  resetPolicyGrants();
  const { project, home, key } = setup(t);
  const { ts, asked } = tools(project, home, { answers: ['不允许'] });
  permissions.setMode('full');
  t.after(() => permissions.setMode('ask'));

  const r = await ts.read_file({ path: key });
  assert.equal(asked.length, 0, 'full 下不该弹卡（用户：full access 不需要再让用户回答任何东西）');
  assert.equal(String(r?.error || ''), '', '应该读到内容而不是被拒：' + JSON.stringify(r).slice(0, 200));
  assert.match(String(r?.content || r?.text || ''), /PRIVATE/, '真的读到私钥内容');
});

test('0.34.1 ①: full access 下项目外文件同样直接放行', async (t) => {
  resetPolicyGrants();
  const { project, home, outside } = setup(t);
  const { ts, asked } = tools(project, home, { answers: ['不允许'] });
  permissions.setMode('full');
  t.after(() => permissions.setMode('ask'));

  const r = await ts.read_file({ path: path.join(outside, 'a.txt') });
  assert.equal(asked.length, 0);
  assert.equal(String(r?.error || ''), '', 'full 下项目外读取不该被拒');
});

test('0.34.1 ①: full access 下写/删项目外也不问', async (t) => {
  resetPolicyGrants();
  const { project, home, outside } = setup(t);
  const { ts, asked } = tools(project, home, { answers: ['不允许'] });
  permissions.setMode('full');
  t.after(() => permissions.setMode('ask'));

  const w = await ts.write_file({ path: path.join(outside, 'b.txt'), content: 'written-by-full' });
  assert.equal(asked.length, 0, 'full 下写项目外不问');
  assert.equal(String(w?.error || ''), '');
  assert.equal(fs.readFileSync(path.join(outside, 'b.txt'), 'utf8'), 'written-by-full');
});

test('0.34.1 ①: ask 模式下行为不变（越界照样问）', async (t) => {
  resetPolicyGrants();
  const { project, home, key } = setup(t);
  const { ts, asked } = tools(project, home, { answers: ['不允许'] });
  permissions.setMode('ask');

  await ts.read_file({ path: key });
  assert.equal(asked.length, 1, 'ask 模式必须仍然弹卡');
});

/* ================= ② full 下仍必须问/拒的 ================= */

test('0.34.1 ②: 灾难命令黑名单在 full 下照旧直接拒绝（不可提问）', (t) => {
  const { project } = setup(t);
  const p = createPolicy({ projectPath: project, mode: 'workspace' });
  // 黑名单是 checkCommand 的职责，与 permissionMode 无关（full 也不会放行）
  const cases = [
    ['shutdown /s /t 0', 'shutdown'],
    ['format D: /y', 'format-disk'],
    ['del /f /q x', 'del-force'],
    ['rm -rf /', 'rm-recursive']
  ];
  for (const [cmd, rule] of cases) {
    const r = checkCommand(p, cmd);
    assert.equal(r.ok, false, `${cmd} 必须被黑名单挡住`);
    assert.equal(r.matchedRule, rule, `${cmd} 应命中 ${rule}，实际 ${r.matchedRule}`);
  }
});

test('0.34.1 ②: full 模式不影响 CU 授权与真 Edge consent 的独立闸', () => {
  // 这两条各有独立实现（computer_request_access / browser_connect_real），
  // 走的是 askUser 直连而不是 askPolicyOverride —— 这里用源码钉住，
  // 防止以后的「full 全放行」重构顺手删掉它们。
  const src = fs.readFileSync('desktop/src/main/agent-tools.mjs', 'utf8');
  assert.match(src, /computer_request_access/, 'CU 授权工具必须存在');
  assert.match(src, /buildRealConsentPrompt/, '真 Edge consent 卡必须存在');

  // CU 授权块里不能有 full 短路。注意：**要先剥掉注释再判**，
  // 否则我写在 askPolicyOverride 上方那条说明「full 不短路 CU」的注释会被自己误判。
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const cuStart = src.indexOf("tools.computer_request_access");
  assert.ok(cuStart > 0, '必须能找到 CU 授权工具的实现');
  const cuBody = stripComments(src.slice(cuStart, cuStart + 1200));
  assert.equal(/getMode\(\)\s*===\s*'full'/.test(cuBody), false, 'CU 授权代码里不能有 full 短路');

  // 真 Edge consent 同理
  const realStart = src.indexOf('buildRealConsentPrompt({');
  assert.ok(realStart > 0);
  const realBody = stripComments(src.slice(Math.max(0, realStart - 400), realStart + 800));
  assert.equal(/getMode\(\)\s*===\s*'full'/.test(realBody), false, '真 Edge consent 里不能有 full 短路');
});

/* ================= ③ 任务栏提醒 ================= */

test('0.34.1 ③: attention 模块存在且只对 Windows 生效', async () => {
  const m = await import('../desktop/src/main/attention.mjs');
  assert.equal(typeof m.markAttention, 'function');
  assert.equal(typeof m.clearAttention, 'function');
  // 非 Windows 平台调用不该抛（CI 跑在 Linux 上也要过）
  const fakeWin = { isDestroyed: () => false, isVisible: () => true, isFocused: () => true, isMinimized: () => false, setOverlayIcon: () => {} };
  assert.doesNotThrow(() => m.markAttention(fakeWin, 'question', 'test'));
  assert.doesNotThrow(() => m.clearAttention(fakeWin));
});

test('0.34.1 ③: 提问与回合结束两处都接了提醒', () => {
  const src = fs.readFileSync('desktop/src/main/ipc/ipc-agent.mjs', 'utf8');
  // 提问：ask-user emit 里要提醒
  const askIdx = src.indexOf("w.webContents.send('finalcheck:ask-user'");
  assert.ok(askIdx > 0, '必须存在 ask-user 推送');
  assert.match(src.slice(askIdx, askIdx + 400), /markAttention/, '提问时必须点亮任务栏');
  // 回合收尾：ok/deadline 时要提醒
  assert.match(src, /outcome === 'ok' \|\| outcome === 'deadline'/, '只在正常完成时提醒');
  assert.match(src, /markAttention\?\.\(getWin\(\), 'done'/, '回合收尾要点亮任务栏');
  // 用户点停止（stopped）不该打扰
  const stopSection = src.indexOf("outcome === 'ok'");
  assert.ok(stopSection > 0);
});

test('0.34.1 ③: 窗口获得焦点会清掉红点', () => {
  const idx = fs.readFileSync('desktop/src/main/index.mjs', 'utf8');
  assert.match(idx, /win\.on\('focus'[\s\S]{0,120}clearAttention/, 'focus 要清角标');
});

test('0.34.1 ③: 声音节流存在（不会连弹两次很吵）', () => {
  const src = fs.readFileSync('desktop/src/main/attention.mjs', 'utf8');
  assert.match(src, /now - lastAt < \d+/, '要有节流窗口');
  assert.match(src, /SystemSounds\]::Asterisk/, '用系统提示音，不自带音频文件');
});

/* ================= ④ @ 会话引用 ================= */

test('0.34.1 ④: findMentions 跳过 @session:（不当路径）', () => {
  const out = findMentions('看下 @session:abc-123 这个会话，还有 @src/a.ts');
  assert.equal(out.includes('session:abc-123'), false, '@session: 不该被当成文件路径');
  assert.equal(out.includes('src/a.ts'), true, '普通路径引用仍然保留');
});

test('0.34.1 ④: @session:<id> 展开成完整对话记录', async (t) => {
  const project = tmp(t, 'fc-0341-mention-');
  const fakeSession = {
    title: '上次的排查',
    messages: [
      { role: 'user', content: '为什么登录 500？' },
      { role: 'assistant', content: '因为 JWT 过期没刷新。' },
      { role: 'user', content: Array.isArray([{ type: 'text', text: '那怎么修' }]) ? [{ type: 'text', text: '那怎么修' }] : '那怎么修' }
    ]
  };
  const r = await expandMentions('参考 @session:sess-abc 的结论继续', {
    root: project,
    loadSession: async (sid) => (sid === 'sess-abc' ? fakeSession : null)
  });
  assert.equal(r.blocks.length, 1, '应该有会话块');
  const block = r.blocks[0];
  assert.match(block, /<session id="sess-abc"/, '要带 id');
  assert.match(block, /title="上次的排查"/, '要带标题');
  assert.match(block, /【用户】为什么登录 500？/, '要有用户发言');
  assert.match(block, /【AI】因为 JWT 过期没刷新。/, '要有 AI 发言');
  assert.match(block, /【用户】那怎么修/, '数组形式的多段内容也要能取出来');
  assert.deepEqual(r.attached, ['@session:上次的排查']);
});

test('0.34.1 ④: 读不到的会话进 skipped，不静默失败', async (t) => {
  const project = tmp(t, 'fc-0341-mention2-');
  const r = await expandMentions('看 @session:not-exist', { root: project, loadSession: async () => null });
  assert.equal(r.blocks.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /读不到/);
});

test('0.34.1 ④: 没有 loadSession 时不报错（向后兼容）', async (t) => {
  const project = tmp(t, 'fc-0341-mention3-');
  fs.writeFileSync(path.join(project, 'note.txt'), 'hello');
  const r = await expandMentions('读 @note.txt', { root: project });
  assert.equal(r.blocks.length, 1, '普通文件引用仍然工作（旧行为不破坏）');
  assert.match(r.blocks[0], /hello/);
});

test('0.34.1 ④: 超长会话记录会被截断（不会撑爆上下文）', async (t) => {
  const project = tmp(t, 'fc-0341-mention4-');
  const big = { title: '巨型会话', messages: Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(4000) })) };
  const r = await expandMentions('看 @session:big', { root: project, loadSession: async () => big });
  const block = r.blocks[0] || '';
  assert.ok(block.length < 210 * 1024, '必须截断到 200KB 以内，实际 ' + block.length);
  assert.match(block, /更早的内容已省略/, '截断要说明');
});

/* ================= ⑤ 同目录兄弟文件不该重复问（用户截图实证） ================= */

test('0.34.1 ⑤: 项目外同目录的多个文件，授权一次就都放行（不再逐个弹卡）', async (t) => {
  resetPolicyGrants();
  const { project, home, outside } = setup(t);
  // 造一个子目录，里面放三个文件（模拟用户截图里的 server/lib/validate|draft|review）
  const sub = path.join(outside, 'lib');
  fs.mkdirSync(sub);
  for (const n of ['validate.mjs', 'draft.mjs', 'review.mjs']) fs.writeFileSync(path.join(sub, n), 'x');
  const { ts, asked } = tools(project, home, { answers: ['这个会话都允许'] });

  const r1 = await ts.read_file({ path: path.join(sub, 'validate.mjs') });
  assert.equal(asked.length, 1, '第一个文件要问一次');
  assert.equal(String(r1?.error || ''), '');

  // 同目录另外两个：不该再问（用户：这种完全不痛不痒的不应该问）
  const r2 = await ts.read_file({ path: path.join(sub, 'draft.mjs') });
  assert.equal(asked.length, 1, '同目录第二个文件不该再问，实际又问了 ' + asked.length + ' 次');
  const r3 = await ts.read_file({ path: path.join(sub, 'review.mjs') });
  assert.equal(asked.length, 1, '同目录第三个文件也不该再问');
  assert.equal(String(r2?.error || ''), '');
  assert.equal(String(r3?.error || ''), '');
});

test('0.34.1 ⑤: 不同目录仍要单独授权（不是一次全放开）', async (t) => {
  resetPolicyGrants();
  const { project, home, outside } = setup(t);
  const a = path.join(outside, 'dirA'); const b = path.join(outside, 'dirB');
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'x.txt'), 'x'); fs.writeFileSync(path.join(b, 'y.txt'), 'y');
  const { ts, asked } = tools(project, home, { answers: ['这个会话都允许', '这个会话都允许'] });

  await ts.read_file({ path: path.join(a, 'x.txt') });
  assert.equal(asked.length, 1);
  await ts.read_file({ path: path.join(b, 'y.txt') });
  assert.equal(asked.length, 2, '换目录必须重新问');
});

test('0.34.1 ⑤: 敏感路径仍按具体文件记账（允许一把钥匙不等于放开同目录另一把）', async (t) => {
  resetPolicyGrants();
  const { project, home } = setup(t);
  const sshDir = path.join(home, '.ssh');
  const k2 = path.join(sshDir, 'other_key');
  fs.writeFileSync(k2, 'OTHER\n');
  const k1 = path.join(sshDir, 'deploy_key');
  const { ts, asked } = tools(project, home, { answers: ['这个会话都允许', '这个会话都允许'] });

  await ts.read_file({ path: k1 });
  assert.equal(asked.length, 1);
  await ts.read_file({ path: k2 });
  assert.equal(asked.length, 2, '敏感路径是逐把钥匙授权，不能因为同目录就一起放开');
});

test('0.34.1 ⑤: policyGrantKey 对项目外退到父目录，对敏感路径不退', () => {
  // 项目外：同目录两个文件得到同一个键（授权一次覆盖整目录）
  const outsideA = policyGrantKey('outside', 'D:/other/sub/a.js');
  const outsideB = policyGrantKey('outside', 'D:/other/sub/b.js');
  assert.equal(outsideA, outsideB, '同目录两个文件必须同键，实际 ' + outsideA + ' vs ' + outsideB);
  assert.match(outsideA, /d:\/other\/sub$/, '键应退到父目录而不是完整文件路径');
  // 不同目录仍是不同键
  assert.notEqual(outsideA, policyGrantKey('outside', 'D:/other/another/c.js'));

  // 敏感路径：逐文件，不合并
  const k1 = policyGrantKey('sensitive', 'C:/k/id_rsa');
  const k2 = policyGrantKey('sensitive', 'C:/k/other_key');
  assert.notEqual(k1, k2, '敏感路径必须是不同键（逐把钥匙授权）');
  assert.match(k1, /id_rsa$/, '敏感路径保留完整文件名');

  // 删除类不退到目录（删整目录比读整目录危险得多）
  const del1 = policyGrantKey('destructive-outside', 'D:/x/a.txt');
  const del2 = policyGrantKey('destructive-outside', 'D:/x/b.txt');
  assert.notEqual(del1, del2, '删除类必须逐文件确认');

  // 命令类带程序名
  const c1 = policyGrantKey('sensitive-path', 'C:/k/id_rsa', { mode: 'exec', program: 'remote-shell' });
  assert.match(c1, /exec\|remote-shell\|/, '命令类键要含程序名');
});
