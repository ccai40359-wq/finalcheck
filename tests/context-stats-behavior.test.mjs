// 0.31.2 行为测试：真的调用 finalcheck:context:stats，验证压缩前后数字真的会变。
// 与 context-stats-after-compact.test.mjs 的区别：那个钉源码，这个跑真处理器（fake ipcMain + 真 sqlite 会话）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 会话库走临时目录（sessions.mjs 按 FINALCHECK_SESSIONS_DIR 分目录）
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fc-ctxstats-'));
process.env.FINALCHECK_SESSIONS_DIR = tmpDir;

test.after(() => rmSync(tmpDir, { recursive: true, force: true }));

const load = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);

test('context:stats 行为：压缩后 used 必须明显小于压缩前（真实 IPC 处理器）', async () => {
  const { registerSystemIpc } = await load('desktop/src/main/ipc/ipc-system.mjs');
  const sessions = await load('desktop/src/main/sessions.mjs');
  const { BOUNDARY_HEAD } = await load('desktop/src/main/compact.mjs');

  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const sessionUsage = new Map();

  // 最小配置：一个供应商 + 一个模型（窗口给 200k，便于断言百分比）
  const cfg = {
    providers: [{ id: 'p1', name: 'P', baseUrl: 'https://x.test', apiKey: 'k', models: [{ id: 'm1', contextWindow: 200000 }], enabled: true }],
    activeProviderId: 'p1'
  };
  registerSystemIpc({
    ipcMain,
    getWin: () => null,
    engineUrl: (rel) => pathToFileURL(path.join(repoRoot, rel)).href,
    store: {
      loadConfig: async () => cfg,
      pickActiveProvider: () => cfg.providers[0]
    },
    getHooksConfig: () => null,
    sessionProjectPathOf: () => '',
    sessionUsage
  });

  const stats = await handlers.get('finalcheck:context:stats');

  // 造一个会话：两大段历史落库（带 at），前端 wire 里也带上。
  // 会话 ID 必须是 sessions.mjs 的 OK_ID 形状（/^[a-f0-9-]{8,64}$/），用真 newSession 拿到合法 id。
  const created = await sessions.newSession('ctxstats');
  const sid = String(created.id);
  await sessions.appendUserMessage(sid, 'a'.repeat(40000));
  await sessions.appendAssistantMessage(sid, 'b'.repeat(40000), [], {});
  const db = await sessions.loadSession(sid);
  const ats = db.messages.map((m) => Number(m.at) || 0);
  const cut = Math.max(...ats) + 1;

  const wire = [
    { role: 'user', content: 'a'.repeat(40000) },
    { role: 'assistant', content: 'b'.repeat(40000) },
    { role: 'user', content: '继续' }
  ];

  // ① 压缩前
  const before = await stats(null, { messages: wire, sessionId: sid });
  assert.ok(before.used > 18000, `压缩前估算应很大，实际 ${before.used}`);
  assert.equal(before.window, 200000);

  // ② 写一份摘要（模拟 /compact 完成）
  await sessions.saveSummary(sid, `${BOUNDARY_HEAD}\n交接摘要：之前做了什么…`, { cutAt: cut });

  // ③ 压缩后（同一条 wire，历史没变——变的是"实际会发出去的内容"）
  const after = await stats(null, { messages: wire, sessionId: sid });

  // 核心断言：面板数字必须真的降下来（旧实现两次一模一样）。
  // 注意口径：used 里有一部分是与压缩无关的固定开销（系统提示 + 工具 schema + 技能目录，约 1.2 万），
  // 所以不能按「少一个数量级」断言——要看**历史那部分的降幅**：两段 4 万字符 ≈ 2 万 token 必须消失。
  const dropped = before.used - after.used;
  assert.ok(dropped > 15000,
    `压缩后必须掉掉「历史那两段」的量级：before=${before.used} after=${after.used} dropped=${dropped}（旧实现 dropped≈0）`);
  assert.ok(after.percent < before.percent, '占用率也要跟着降');
  // 剩下的应主要是固定开销（系统提示/工具/技能），不该还留着压缩前的大段历史
  const fixedPart = after.breakdown.systemTools + after.breakdown.skills + after.breakdown.systemPrompt;
  assert.ok(after.used - fixedPart < 3000,
    `除固定开销外不该还有大块内容：after=${after.used} fixed=${fixedPart}`);

  // 摘要确实被算进去了（不是简单丢掉全部历史导致偏小到失真的程度）
  assert.ok(after.breakdown.metaContext > 0, '摘要必须计入 metaContext');
  // 本轮这条「继续」还留着
  assert.ok(after.breakdown.messages > 0, '压缩边界之后的用户消息必须仍然计入');
  assert.ok(after.breakdown.messages < 100, `只该剩「继续」这条，实际 ${after.breakdown.messages}`);

  // ④ 兜底防线：即使内存里还留着压缩前的实测记录（模拟「清记录那条路径没走到」），
  //    面板也不能拿它来显示。构造一条 at 早于 summaryAt 的实测。
  const afterSession = await sessions.loadSession(sid);
  const summaryAt = Number(afterSession.summaryAt) || 0;
  assert.ok(summaryAt > 0, '摘要必须带切分点');
  sessionUsage.set(sid, { prompt: 900000, completion: 100, cached: null, cacheHit: null, at: summaryAt - 5000 });
  const stale = await stats(null, { messages: wire, sessionId: sid });
  assert.equal(stale.measured, null, '摘要之前的实测必须被判定为过期，不能显示 900000');
  assert.ok(stale.used < 20000, `过期实测被拒后 used 仍应是压缩后的口径，实际 ${stale.used}`);

  // ⑤ 反例：摘要之后的实测是有效的（不能把新值也一起丢掉）
  sessionUsage.set(sid, { prompt: 12000, completion: 100, cached: null, cacheHit: 80, at: summaryAt + 5000 });
  const fresh = await stats(null, { messages: wire, sessionId: sid });
  assert.equal(fresh.measured?.prompt, 12000, '压缩之后新产生的实测必须照常显示');
});
