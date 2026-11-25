// 0.33.9：
//   ① 越界不再直接拒绝 LLM，而是问用户（用户：「他要读你的私钥，应该经过用户同意就行；我想让他直接部署到服务器，这也限制就会很麻烦」）
//   ② 工具记录里的图片可点开、截图不再堆到消息底部
//   ③ 图片大图、右栏新标签页
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentTools, resetPolicyGrants, isEscalatable, policyGrantKey, saveToolShot } from '../desktop/src/main/agent-tools.mjs';
import { createPolicy, checkCommandPaths, assertPathAllowed } from '../desktop/src/main/policy.mjs';
import { toolImagePaths, isImagePath } from '../desktop/src/renderer/lib/tool-images.mjs';
import { normalizeLightbox, stepLightbox } from '../desktop/src/renderer/lib/lightbox.mjs';
import { emptyRail, openRailTab, openLauncherTab, chooseFromLauncher, railTabLabel } from '../desktop/src/renderer/lib/rail-tabs.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function tmp(t, prefix = 'fc-0339-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** 一个项目目录 + 项目外一把「私钥」（basename = id_rsa 命中敏感规则） */
function setup(t) {
  const project = tmp(t, 'fc-0339-proj-');
  const outside = tmp(t, 'fc-0339-out-');
  const key = path.join(outside, 'id_rsa');
  fs.writeFileSync(key, 'PRIVATE-KEY-CONTENT\n', 'utf8');
  const other = path.join(outside, 'notes.txt');
  fs.writeFileSync(other, 'outside-notes\n', 'utf8');
  return { project, outside, key, other };
}

function tools(project, { answers = [], approvals = null, sessionId = 's-0339' } = {}) {
  const asked = [];
  let approvalCalls = 0;
  const ts = createAgentTools({
    repoRoot, projectPath: project, sessionId,
    policy: createPolicy({ projectPath: project, mode: 'workspace' }),
    permissions: {
      requestApproval: async () => { approvalCalls++; return approvals || 'allowed-once'; },
      sessionAllowed: () => false
    },
    recordAudit: async () => {},
    askUser: answers === null ? null : async (card) => { asked.push(card); return { ok: true, answer: answers.shift() ?? '不允许' }; }
  });
  return { ts, asked, approvals: () => approvalCalls };
}

test('policy：敏感 / 项目外的拒绝带 matchedRule，能问；只读写入不能问', () => {
  const p = createPolicy({ projectPath: 'D:/proj', mode: 'workspace' });
  const sens = assertPathAllowed(p, 'C:/Users/x/.ssh/id_rsa', { tool: 'read_file' });
  assert.equal(sens.matchedRule, 'sensitive');
  assert.ok(isEscalatable(sens));
  const out = assertPathAllowed(p, 'D:/other/a.txt', { tool: 'read_file' });
  assert.equal(out.matchedRule, 'outside');
  const ro = createPolicy({ projectPath: 'D:/proj', mode: 'readonly' });
  const w = assertPathAllowed(ro, 'D:/proj/a.txt', { write: true, tool: 'write_file' });
  assert.equal(w.ok, false);
  assert.equal(isEscalatable(w), false, '只读模式写入不弹卡，照旧拒绝');
  assert.equal(policyGrantKey('sensitive-path', 'C:\\A\\B'), policyGrantKey('sensitive', 'c:/a/b'));
});

test('read_file 读私钥：先问用户；允许这一次 → 读到；下一次还会问', async (t) => {
  resetPolicyGrants();
  const { project, key } = setup(t);
  const { ts, asked } = tools(project, { answers: ['允许这一次', '不允许'] });
  const r = await ts.read_file({ path: key });
  assert.equal(asked.length, 1);
  assert.match(asked[0].question, /敏感文件/);
  assert.deepEqual(asked[0].options.map((o) => o.label), ['允许这一次', '这个会话都允许', '不允许']);
  assert.match(String(r.content || ''), /PRIVATE-KEY-CONTENT/, JSON.stringify(r).slice(0, 200));
  const again = await ts.read_file({ path: key });
  assert.equal(asked.length, 2, '「允许这一次」不记住');
  assert.equal(again.deniedBy, 'user-declined');
  assert.match(again.error, /用户不同意/);
});

test('「这个会话都允许」：同一会话同一目标不再问，跨回合（重建工具）也记得；别的会话照样问', async (t) => {
  resetPolicyGrants();
  const { project, other } = setup(t);
  const a = tools(project, { answers: ['这个会话都允许'] });
  assert.match(String((await a.ts.read_file({ path: other })).content), /outside-notes/);
  const b = tools(project, { answers: [] }); // 新回合（工具重建）
  assert.match(String((await b.ts.read_file({ path: other })).content), /outside-notes/);
  assert.equal(b.asked.length, 0);
  const c = tools(project, { answers: ['不允许'], sessionId: 's-other' });
  assert.equal((await c.ts.read_file({ path: other })).deniedBy, 'user-declined');
  assert.equal(c.asked.length, 1);
});

test('没有提问通道（子代理）：照旧拒绝，但告诉模型交给主对话去问用户', async (t) => {
  resetPolicyGrants();
  const { project, key } = setup(t);
  const { ts } = tools(project, { answers: null });
  const r = await ts.read_file({ path: key });
  assert.equal(r.deniedBy, 'policy');
  assert.match(r.hint, /主对话去问用户/);
});

test('run_command 引用项目外路径：问一次，同意后执行，且不再弹普通命令审批', async (t) => {
  resetPolicyGrants();
  const { project, outside } = setup(t);
  const { ts, asked, approvals } = tools(project, { answers: ['允许这一次'] });
  const r = await ts.run_command({ command: `ls "${outside.replace(/\\/g, '/')}"` });
  assert.equal(asked.length, 1);
  assert.match(asked[0].question, /运行命令/);
  assert.equal(r.code, 0, JSON.stringify(r).slice(0, 300));
  assert.match(String(r.stdout), /notes\.txt/);
  assert.equal(approvals(), 0, '用户已经在越界卡里同意过这条命令');
});

test('灾难命令黑名单照旧直接拒绝（不弹卡）', async (t) => {
  resetPolicyGrants();
  const { project } = setup(t);
  const { ts, asked } = tools(project, { answers: ['允许这一次'] });
  const r = await ts.run_command({ command: 'diskpart' });
  assert.equal(r.deniedBy, 'policy');
  assert.equal(asked.length, 0);
});

test('终端颜色码 \\x1b[32m 不再被当成项目外路径（0.33.7 实测误拒）', () => {
  const p = createPolicy({ projectPath: 'D:/proj', mode: 'workspace' });
  const cmd = String.raw`node -e "console.log('\x1b[32mVITE\x1b[0m ready')"`;
  assert.deepEqual(checkCommandPaths(p, cmd), { ok: true });
  assert.equal(checkCommandPaths(p, 'cat C:/Users/x/.ssh/id_rsa').matchedRule, 'sensitive-path', '真路径照样识别');
});

test('工具记录里的图片：view_image / read_file 图片 / 各类截图都能拿到可点的路径', () => {
  assert.deepEqual(toolImagePaths({ type: 'tool', name: 'view_image', args: '{"path":"D:/a/x.png"}', result: { ok: true, images: [{ path: 'D:/a/x.png' }] } }), ['D:/a/x.png']);
  assert.deepEqual(toolImagePaths({ type: 'tool', name: 'read_file', args: { path: 'D:/cap/01-about.png' }, result: {} }), ['D:/cap/01-about.png']);
  assert.deepEqual(toolImagePaths({ type: 'tool', name: 'browser_screenshot', args: {}, result: { ok: true, path: 'C:/t/browser-1.png' } }), ['C:/t/browser-1.png']);
  assert.deepEqual(toolImagePaths({ type: 'tool', name: 'read_file', args: { path: 'D:/a/b.js' }, result: {} }), [], '不是图片不出链接');
  assert.deepEqual(toolImagePaths({ type: 'tool', name: 'capture_screenshot', args: {}, result: { error: 'x', path: 'D:/a.png' } }), [], '失败的不出链接');
  assert.ok(isImagePath('A.JPEG'));
});

test('浏览器 / 桌面截图落一份文件（系统临时目录），工具行才有文件名可点', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const f = saveToolShot(png, 'image/png', 'browser');
  assert.ok(f.startsWith(path.join(os.tmpdir(), 'finalcheck-shots')), f);
  assert.ok(f.endsWith('.png'));
  assert.equal(fs.readFileSync(f).length, png.length);
  fs.rmSync(f, { force: true });
  assert.equal(saveToolShot(Buffer.alloc(0)), '');
});

test('图片大图：去掉无效项、下标夹紧、左右循环', () => {
  assert.equal(normalizeLightbox({ items: [] }), null);
  const s = normalizeLightbox({ items: [{ src: 'data:a' }, { src: '' }, { src: 'data:b' }], index: 9 });
  assert.equal(s.items.length, 2);
  assert.equal(s.index, 1);
  assert.equal(stepLightbox(s, 1).index, 0);
  assert.equal(stepLightbox(s, -1).index, 0);
});

test('右栏新标签页：开一次就一个；选了某项后新标签页让位；已开着的直接切过去', () => {
  let rail = openLauncherTab(emptyRail());
  rail = openLauncherTab(rail);
  assert.deepEqual(rail.tabs.map((x) => x.key), ['launcher']);
  assert.equal(railTabLabel(rail.tabs[0]), '新标签');
  rail = chooseFromLauncher(rail, { kind: 'files' });
  assert.deepEqual(rail.tabs.map((x) => x.key), ['files']);
  assert.equal(rail.activeKey, 'files');
  rail = openRailTab(rail, { kind: 'artifact', artifactPath: 'D:/a.png' }).rail;
  rail = openLauncherTab(rail);
  rail = chooseFromLauncher(rail, { kind: 'files' });
  assert.deepEqual(rail.tabs.map((x) => x.key), ['files', 'artifact:D:/a.png']);
  assert.equal(rail.activeKey, 'files');
});

test('界面源码钉：输入框 / 消息图片点开是大图；工具行图片文件名可点；顶栏能打开右栏', () => {
  const read = (p) => fs.readFileSync(path.join(repoRoot, 'desktop/src/renderer', p), 'utf8');
  assert.match(read('components/Composer.jsx'), /data-testid="composer-image"[\s\S]*openLightbox\(/);
  assert.match(read('components/MessageList.jsx'), /data-testid="message-image"/);
  // 真界面实测抓到过：只调用没 import（JSX 文件 lint 不报 no-undef），点了没反应
  for (const f of ['components/MessageList.jsx', 'components/Composer.jsx']) {
    assert.match(read(f), /import \{[^}]*openLightbox[^}]*\} from '..\/lib\/lightbox.mjs'/, f + ' 必须 import openLightbox');
  }
  assert.match(read('chat/ProcessTimeline.jsx'), /data-testid="tool-image-link"/);
  assert.match(read('components/ChatHeader.jsx'), /data-testid="rail-open"/);
  assert.match(read('chat/RightRail.jsx'), /data-testid="rail-new-tab"/);
  assert.match(read('App.jsx'), /<ImageLightbox /);
});
