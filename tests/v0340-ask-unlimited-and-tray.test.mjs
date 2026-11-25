// 0.34.0 回归测试：
//   ① 每回合提问次数不再设上限（用户定案），但显式 maxPerTurn 仍可限流
//   ② 越界提权的 deniedBy 如实反映原因，不再一律冒充 'policy'
//   ③ 会话级授权读/写分桶——允许读私钥不等于允许覆盖它（0.33.9 的真漏洞）
//   ④ 命令类授权按「程序 + 命中路径」记账，ssh 家族合一个桶
//   ⑤ scp/rsync 的远端写法 host:/opt 不再被当成 T: 盘路径误拦
//   ⑥ 托盘：关窗口不销毁 webContents，真退出放行
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentTools, resetPolicyGrants, policyGrantKey, commandProgramKey } from '../desktop/src/main/agent-tools.mjs';
import { createPolicy, checkCommandPaths } from '../desktop/src/main/policy.mjs';
import { createAskUserRegistry } from '../desktop/src/main/ask-user.mjs';
import { ASK_USER_MAX_PER_TURN } from '../desktop/src/renderer/lib/ask-user.mjs';

const BS = String.fromCharCode(92); // 反斜杠：避免在 JS 字面量里写 NaN 转义
const repoRoot = path.resolve(import.meta.dirname, '..');

function tmp(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** 项目目录 + 一个家目录（里面放 .ssh/<name>，命中敏感规则）+ 项目外的普通文件 */
function setup(t) {
  const project = tmp(t, 'fc-0340-proj-');
  const home = tmp(t, 'fc-0340-home-');
  const outside = tmp(t, 'fc-0340-out-');
  fs.mkdirSync(path.join(home, '.ssh'));
  const key = path.join(home, '.ssh', 'deploy_key');
  fs.writeFileSync(key, 'ORIGINAL-KEY-CONTENT\n');
  fs.writeFileSync(path.join(outside, 'notes.txt'), 'notes\n');
  fs.writeFileSync(path.join(outside, 'other.txt'), 'other\n');
  return { project, home, outside, key };
}

/** 造一套工具；answers 是依次给用户的回答 */
function tools(project, home, { answers = [], sessionId = 's-0340' } = {}) {
  const asked = [];
  const ts = createAgentTools({
    repoRoot, projectPath: project, sessionId,
    policy: createPolicy({ projectPath: project, mode: 'workspace', home }),
    permissions: { requestApproval: async () => 'allowed-once', sessionAllowed: () => false },
    recordAudit: async () => {},
    askUser: answers === null ? null : async (card) => {
      asked.push(card);
      return { ok: true, answer: answers.shift() ?? '不允许' };
    }
  });
  return { ts, asked };
}

/* ================= ① 不再限制每回合提问次数 ================= */

test('0.34.0 ①: 默认每回合提问次数无上限', () => {
  assert.equal(ASK_USER_MAX_PER_TURN, Number.POSITIVE_INFINITY);
});

test('0.34.0 ①: 真实 registry 连问 10 次全部弹卡并都能回答', async () => {
  const seen = [];
  const reg = createAskUserRegistry({ emit: (p) => seen.push(p) });
  reg.beginTurn('s-many');
  const pending = [];
  for (let i = 0; i < 10; i += 1) pending.push(reg.ask({ question: `问题 ${i}`, sessionId: 's-many' }));
  assert.equal(seen.length, 10, '10 次全部弹卡（旧实现第 4 次就被拒）');
  for (const p of seen) reg.answer({ callId: p.callId, answer: '好' });
  const out = await Promise.all(pending);
  assert.equal(out.filter((r) => r.answer === '好').length, 10);
  assert.equal(reg.pendingCount(), 0);
});

test('0.34.0 ①: 越界提权连续 6 次不再被「提问次数已达上限」挡住', async (t) => {
  resetPolicyGrants();
  const { project, home, outside } = setup(t);
  const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt'];
  for (const n of names) fs.writeFileSync(path.join(outside, n), n);
  // 每次都换一个文件 → 每次都是一个新授权键，都会真问
  const { ts, asked } = tools(project, home, { answers: names.map(() => '不允许') });
  const S = 's-0340-多';
  const reg = createAskUserRegistry({ emit: () => {} });
  reg.beginTurn(S);
  for (const n of names) {
    const r = await ts.read_file({ path: path.join(outside, n) });
    // 用户每次都说不允许 → 每次都是 user-declined，绝不是「次数已达上限」
    assert.equal(r.deniedBy, 'user-declined', `${n} 应是被用户拒绝，而不是额度用完`);
    assert.doesNotMatch(String(r.error), /次数已达上限/);
  }
  await reg.cancelAll();
  assert.equal(asked.length, 6, '6 次都弹了卡');
});

/* ================= ② deniedBy 如实反映原因 ================= */

test('0.34.0 ②: 没有提问通道 → deniedBy:ask-unavailable（不是 policy）', async (t) => {
  resetPolicyGrants();
  const { project, home, key } = setup(t);
  const { ts } = tools(project, home, { answers: null });
  const r = await ts.read_file({ path: key });
  assert.equal(r.deniedBy, 'ask-unavailable');
  assert.match(r.hint, /主对话去问用户/);
});

test('0.34.0 ②: 用户拒绝 → deniedBy:user-declined；用户取消 → deniedBy:user-cancelled', async (t) => {
  resetPolicyGrants();
  const { project, home, key } = setup(t);
  const declined = tools(project, home, { answers: ['不允许'] });
  const r1 = await declined.ts.read_file({ path: key });
  assert.equal(r1.deniedBy, 'user-declined');

  // 用户点停止：registry 把 pending 收成 cancelled
  const S = 's-0340-cancel';
  const reg = createAskUserRegistry({ emit: () => {} });
  reg.beginTurn(S);
  const ts2 = createAgentTools({
    repoRoot, projectPath: project, sessionId: S,
    policy: createPolicy({ projectPath: project, mode: 'workspace', home }),
    permissions: { requestApproval: async () => 'allowed-once', sessionAllowed: () => false },
    recordAudit: async () => {},
    askUser: (args) => reg.ask({ ...args, sessionId: S })
  });
  const pend = ts2.read_file({ path: key });
  await new Promise((r) => setImmediate(r));
  reg.cancelSession(S); // 模拟用户点停止
  const r2 = await pend;
  assert.equal(r2.deniedBy, 'user-cancelled');
});

/* ================= ③ 读/写分桶（0.33.9 的真漏洞） ================= */

test('0.34.0 ③: 允许读私钥之后，覆盖写同一个私钥必须再问，且拒绝时文件不动', async (t) => {
  resetPolicyGrants();
  const { project, home, key } = setup(t);
  const { ts, asked } = tools(project, home, { answers: ['这个会话都允许', '不允许'] });

  const r1 = await ts.read_file({ path: key });
  assert.doesNotMatch(String(r1.error || ''), /敏感|拒绝/, '读了：' + JSON.stringify(r1).slice(0, 200));
  assert.equal(asked.length, 1);

  const r2 = await ts.write_file({ path: key, content: 'HACKED\n' });
  assert.equal(asked.length, 2, '写必须单独问一次（0.33.9 这里不弹卡，直接写进去了）');
  assert.equal(r2.deniedBy, 'user-declined');
  assert.equal(fs.readFileSync(key, 'utf8'), 'ORIGINAL-KEY-CONTENT\n', '用户说了不允许，文件必须原样');

  // 再读一次：读的授权还在，不该再问
  const before = asked.length;
  await ts.read_file({ path: key });
  assert.equal(asked.length, before, '读的「会话都允许」应当仍然有效');
});

test('0.34.0 ③: grantKey 把读与写分成两个不同的键', () => {
  const p = 'C:/Users/x/.ssh/deploy_key';
  const read = policyGrantKey('sensitive', p, { mode: 'read' });
  const write = policyGrantKey('sensitive', p, { mode: 'write' });
  const exec = policyGrantKey('sensitive-path', p, { mode: 'exec', program: 'remote-shell' });
  assert.notEqual(read, write);
  assert.notEqual(read, exec);
  assert.notEqual(write, exec);
  // destructive* 规则即使没显式给 mode 也算写
  assert.equal(policyGrantKey('destructive-sensitive', p), write);
});

/* ================= ④ 命令类授权粒度 ================= */

test('0.34.0 ④: ssh 家族（ssh/scp/rsync/sftp）共用一个授权桶', () => {
  assert.equal(commandProgramKey('ssh -i k host ls'), 'remote-shell');
  assert.equal(commandProgramKey('scp -i k a.txt host:/opt/'), 'remote-shell');
  assert.equal(commandProgramKey('rsync -av ./x host:/opt/'), 'remote-shell');
  assert.equal(commandProgramKey('sftp -i k host'), 'remote-shell');
  assert.equal(commandProgramKey('"C:/Windows/System32/ssh.exe" -i k host'), 'remote-shell');
  assert.equal(commandProgramKey('git status'), 'git');
  assert.equal(commandProgramKey('a && b'), 'a');
});

test('0.34.0 ④: 授权一次 key 之后，写法和目标都变了也不再问', async (t) => {
  resetPolicyGrants();
  const { project, home, key } = setup(t);
  const slashKey = key.replace(/\\/g, '/');
  const { ts, asked } = tools(project, home, { answers: ['这个会话都允许'] });

  const first = await ts.run_command({ command: `ssh -F none -i "${slashKey}" deploy@127.0.0.1 true` });
  assert.equal(asked.length, 1);
  void first;
  // 换成 scp、换成另一个子命令：都属于「remote-shell 用这把 key」，不再问
  const second = await ts.run_command({ command: `scp -i "${slashKey}" "${path.join(home, 'x.txt')}" deploy@127.0.0.1:/opt/` });
  assert.equal(asked.length, 1, `同桶不该再问，实际问了 ${asked.length} 次`);
  void second;
  // 换一把 key：必须重新问（授权是按「哪把钥匙」给的）
  const other = path.join(home, '.ssh', 'other_key');
  fs.writeFileSync(other, 'OTHER\n');
  await ts.run_command({ command: `ssh -i "${other.replace(/\\/g, '/')}" deploy@127.0.0.1 true` });
  assert.equal(asked.length, 2, '换了一把 key 必须重新问');
});

/* ================= ⑤ 远端路径不再误判 ================= */

test('0.34.0 ⑤: scp/rsync 的 host:/path 不当成盘符路径', () => {
  const p = createPolicy({ projectPath: 'D:/proj', mode: 'workspace' });
  for (const cmd of [
    'rsync -av ./out/ box:/opt/x/',
    'rsync -av ./out/ myserver:/opt/app/',
    'scp a.txt myserver:/opt/app/',
  ]) {
    const r = checkCommandPaths(p, cmd, 'D:/proj');
    assert.equal(r.ok, true, `${cmd} 不该被拦：${r.reason || ''}`);
  }
});

test('0.34.0 ⑤: 真正的盘符路径与敏感路径照旧拦住（修完不能漏）', () => {
  const p = createPolicy({ projectPath: 'D:/proj', mode: 'workspace' });
  const win = 'type ' + 'E:' + BS + 'other' + BS + 'secret.txt';
  const r1 = checkCommandPaths(p, win, 'D:/proj');
  assert.equal(r1.ok, false, '盘符绝对路径仍要被判项目外');
  assert.equal(r1.matchedRule, 'path-outside');

  const r2 = checkCommandPaths(p, 'cat ~/.ssh/id_rsa', 'D:/proj');
  assert.equal(r2.ok, false);
  assert.equal(r2.matchedRule, 'sensitive-path');
  assert.ok(r2.target, '命中的规范化路径要带出来（授权键要用）');
});

test('0.34.0 ⑤: user@host:/path 也不误判，但同条命令里的真实盘符路径仍拦', () => {
  const p = createPolicy({ projectPath: 'D:/proj', mode: 'workspace' });
  assert.equal(checkCommandPaths(p, 'ssh deploy@host "ls /opt/x"', 'D:/proj').ok, true);
  const both = `scp a.txt host:/opt/ && type E:${BS}secret.txt`;
  const r = checkCommandPaths(p, both, 'D:/proj');
  assert.equal(r.ok, false, '复合命令里夹带的盘符路径仍要拦');
});

/* ================= ⑥ 托盘行为契约 ================= */
// 这里不启动 Electron（测试进程里没有 app 实例），改为核对源码里的关键不变量：
// 一旦有人把 preventDefault 删了、或把 markQuitting 漏了，这几条会立刻红。
// 真人视觉验收在 scripts/ui-selfcheck-tray.mjs 里用真 Electron 跑（截图取证）。

test('0.34.0 ⑥: 托盘关窗不销毁 webContents，真退出放行', () => {
  const src = fs.readFileSync('desktop/src/main/tray.mjs', 'utf8');
  assert.match(src, /if \(quitting\) return;/, 'quitting 时要放行 close');
  assert.match(src, /e\.preventDefault\(\)/, '非退出时必须 preventDefault，否则窗口被销毁');
  assert.match(src, /^let tray = null;/m, '托盘引用必须放模块级，否则被 GC 后图标消失');
  assert.match(src, /export function markQuitting/, '要有 markQuitting 给 app.quit 用');
  assert.match(src, /tray\.on\('click'/, '点图标要能回来');
});

test('0.34.0 ⑥: index 里托盘先于建窗、退出前 markQuitting、有托盘时窗口全关不退出', () => {
  const idx = fs.readFileSync('desktop/src/main/index.mjs', 'utf8');
  assert.ok(idx.indexOf('installTray({') < idx.indexOf('createWindow();'), '托盘必须在 createWindow 之前建');
  assert.match(idx, /if \(trayReady\(\)\) attachHideOnClose\(win\)/, '只在托盘真建起来时才收托盘');
  assert.match(idx, /if \(trayReady\(\)\) return;/, 'window-all-closed 时有托盘要留在后台');
  assert.match(idx, /app\.on\('before-quit'[\s\S]{0,200}markQuitting\(\)/, 'before-quit 必须放行，否则退不掉');
  assert.match(idx, /app\.on\('will-quit'[\s\S]{0,80}destroyTray\(\)/, '退出时销毁托盘图标');
  assert.match(idx, /if \(!win\.isVisible\(\)\) win\.show\(\);/, '第二次启动要把隐藏的窗口叫回来');
});

test('0.34.0 ⑥: 后台驱动模式与 UI 自检不建托盘（避免 CI 上留幽灵进程）', () => {
  const idx = fs.readFileSync('desktop/src/main/index.mjs', 'utf8');
  assert.match(idx, /FINALCHECK_WINDOW_BG !== '1' && process\.env\.FINALCHECK_UI_SELFCHECK !== '1'/);
});

/* ================= ⑦ 压缩提示只留消息流那一条 ================= */

test('0.34.0 ⑦: 输入框上的压缩绿点已移除', () => {
  const src = fs.readFileSync('desktop/src/renderer/components/Composer.jsx', 'utf8');
  assert.equal(/fc-compact-dot/.test(src), false, 'Composer 不该再有压缩绿点');
  assert.equal(/bg-jade[^"]*rounded-full[^"]*fc-compact/.test(src), false);
  // 消息流里的分隔线仍在（不能把压缩提示整个删掉）
  const line = fs.readFileSync('desktop/src/renderer/components/CompactionStatus.jsx', 'utf8');
  assert.match(line, /fc-compact-sweep|正在压缩/, '消息流的压缩分隔线要保留');
});
