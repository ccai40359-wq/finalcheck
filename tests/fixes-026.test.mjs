// 0.26：模拟客户端测试台抓出来的真实问题，各补一条回归测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { effortParam } from '../desktop/src/main/agent-service.mjs';
import { createPolicy, assertPathAllowed, checkCommandPaths, checkDestructiveTargets } from '../desktop/src/main/policy.mjs';
import { appendKeepEnds, markOmitted, runCommandWithSignal, COMMAND_STDOUT_CAP } from '../desktop/src/main/agent-tools.mjs';
import { expandToolHistory, toolContentOf } from '../desktop/src/main/full-history.mjs';
import { buildSendHistory } from '../desktop/src/renderer/lib/interrupted-digest.mjs';

test('思考强度 Default（跟随模型默认）不发 reasoning_effort；其余档位照发', () => {
  assert.deepEqual(effortParam('default'), {});
  assert.deepEqual(effortParam(''), {});
  assert.deepEqual(effortParam(undefined), {});
  assert.deepEqual(effortParam('max'), { reasoning_effort: 'max' });
  assert.deepEqual(effortParam('Low'), { reasoning_effort: 'low' });
});

test('落盘目录只读放行：read_file / 命令能读；删除、借 ../ 读配置仍拒绝', () => {
  const appData = path.join(os.tmpdir(), 'fc-pol-026', 'AppData', 'Roaming');
  const spill = path.join(appData, 'FinalCheck', 'spill');
  const env = { APPDATA: appData, FINALCHECK_SPILL_DIR: spill, USERPROFILE: path.join(os.tmpdir(), 'fc-pol-026') };
  const policy = createPolicy({ projectPath: path.join(os.tmpdir(), 'fc-pol-026', 'proj'), mode: 'workspace', env });
  const f = path.join(spill, '123-run_command.json');
  assert.equal(assertPathAllowed(policy, f, { write: false }).ok, true, '读落盘文件应放行');
  assert.equal(assertPathAllowed(policy, f, { write: true }).ok, false, '写落盘目录应拒绝');
  assert.equal(assertPathAllowed(policy, path.join(spill, '..', 'config.json')).ok, false, '../config.json 仍是敏感路径');
  assert.equal(checkCommandPaths(policy, `grep -n "x" "${f.replaceAll('\\', '/')}"`, null).ok, true, '命令里引用落盘文件应放行');
  assert.equal(checkCommandPaths(policy, `cat "${path.join(appData, 'FinalCheck', 'config.json').replaceAll('\\', '/')}"`, null).ok, false, '配置文件仍拒绝');
  assert.equal(checkDestructiveTargets(policy, `rm -f "${f.replaceAll('\\', '/')}"`, null).ok, false, '删除落盘文件应拒绝');
});

test('命令长输出保留头尾、中间标注省略；不再只留前 8000 字符', () => {
  let s = { text: '', dropped: 0 };
  for (let i = 0; i < 2000; i++) s = appendKeepEnds(s.text, `line-${i}\n`, 1000, s.dropped);
  assert.equal(s.text.length, 1000);
  const out = markOmitted(s.text, s.dropped, 1000);
  assert.match(out, /^line-0\n/);
  assert.match(out, /line-1999\n$/);
  assert.match(out, /中间省略 \d+ 字符/);
  assert.equal(markOmitted('short', 0, 1000), 'short');
});

test('run_command 真跑：6000 行输出，结尾那几行模型看得到', async () => {
  const r = await runCommandWithSignal('for i in $(seq 1 6000); do echo row-$i-padpadpadpadpadpadpadpad; done', { idleMs: 0 });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /row-6000-/);
  assert.ok(r.stdout.length <= COMMAND_STDOUT_CAP + 200);
});

test('超长结果跨轮还原：用当轮发给模型的原文（inline），前后两轮逐字节一致', () => {
  const inline = '[结果过长 99999 字符，已完整落盘]\n完整输出: D:/spill/x.json\n--- 前 12000 字符 ---\nHEAD\n--- 后 4000 字符 ---\nTAIL';
  assert.equal(toolContentOf({ result: { truncated: true, spillFile: 'D:/spill/x.json', chars: 99999, preview: 'HEAD', inline } }), inline);
  // 老数据（没有 inline）仍按预览拼
  assert.match(toolContentOf({ result: { truncated: true, spillFile: 'D:/spill/x.json', chars: 99999, preview: 'HEAD' } }), /已完整落盘/);
});

test('中断的回合：紧接着的下一轮和更后面的轮次，都还原成同一份完整工具过程（不再变回摘要）', () => {
  const stopped = { role: 'assistant', content: '', interrupted: true, trace: [{ tool: 'run_command', args: '{"command":"npm test"}', result: { code: 1, stdout: 'FAIL a.test.js' }, say: '先跑测试', callId: 'c1', round: 0 }] };
  const db1 = [{ role: 'user', content: '跑测试' }, stopped];
  const ui1 = [{ role: 'user', content: '跑测试' }, stopped];
  // 第 2 轮（继续）
  const wire2 = [...buildSendHistory(ui1).wire, { role: 'user', content: '继续' }];
  const ex2 = expandToolHistory(wire2, db1);
  assert.equal(ex2.replayed, 1);
  // 第 3 轮（继续之后又问了一句）
  const db2 = [...db1, { role: 'user', content: '继续' }, { role: 'assistant', content: '测试有 1 个失败', trace: [] }];
  const ui2 = [...ui1, { role: 'user', content: '继续' }, { role: 'assistant', content: '测试有 1 个失败', trace: [] }];
  const wire3 = [...buildSendHistory(ui2).wire, { role: 'user', content: '哪个失败了' }];
  const ex3 = expandToolHistory(wire3, db2);
  const prefix2 = ex2.messages.slice(0, -1); // 去掉第 2 轮的用户消息
  assert.deepEqual(ex3.messages.slice(0, prefix2.length), prefix2, '中断回合在后续轮次的表示与上一轮完全一致');
  assert.ok(JSON.stringify(ex3.messages).includes('FAIL a.test.js'), '更后面的轮次仍看得到当时的原始结果');
});

test('落盘目录的登记写法和真实路径不同（8.3 短文件名 / 目录联接）时，读落盘文件仍放行', async () => {
  const fs = await import('node:fs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-junc-026-'));
  const realSpill = path.join(base, 'real', 'AppData', 'Roaming', 'FinalCheck', 'spill');
  fs.mkdirSync(realSpill, { recursive: true });
  fs.writeFileSync(path.join(realSpill, 'x.json'), '{}');
  fs.writeFileSync(path.join(base, 'real', 'AppData', 'Roaming', 'FinalCheck', 'config.json'), '{}');
  const link = path.join(base, 'link');
  fs.symlinkSync(path.join(base, 'real'), link, 'junction');
  const spill = path.join(link, 'AppData', 'Roaming', 'FinalCheck', 'spill');
  const policy = createPolicy({ projectPath: path.join(base, 'proj'), mode: 'workspace', env: { APPDATA: path.join(link, 'AppData', 'Roaming'), FINALCHECK_SPILL_DIR: spill, USERPROFILE: base } });
  assert.equal(assertPathAllowed(policy, path.join(spill, 'x.json')).ok, true);
  assert.equal(assertPathAllowed(policy, path.join(spill, '..', 'config.json')).ok, false, '配置仍拒绝');
});
