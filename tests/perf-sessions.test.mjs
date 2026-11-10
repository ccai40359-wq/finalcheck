// 会话存储性能验收（只压测，不改业务逻辑）
// 覆盖三个之前没压过的点：
//   1) 列表性能：300 个会话（每个 user+assistant，30 个带 5 条 tool part）
//      - 首次 listSessions()（含打开库/schema/迁移扫描）< 1500ms
//      - 二次（库已打开）< 300ms
//      - 列表不读正文：同样 300 个会话，其中 38 条 assistant 正文 1MB，
//        与全短正文的库相比 list 耗时中位数差异 < 2×（取 7 次中位数，加 25ms 噪声地板）
//   2) 单会话打开：1MB 正文会话冷启动 loadSession() < 800ms，且只返回该会话的 2 条消息
//   3) 迁移性能：200 个旧 session-*.json 首次触发迁移 < 5000ms；
//      迁移后 session 计数正确、旧 JSON 文件一个不少
//
// 阈值依据（2026-11 本机 Windows 11 / Node 24.14 实测，见每个测试的 console 输出）：
//   首次 list ≈ 7ms   → 1500ms（>200× 余量；含 CI 冷机/杀软扫描也留足）
//   热 list   ≈ 2ms   → 300ms（>100×）
//   1MB load  ≈ 13ms  → 800ms（>60×）
//   200 迁移  ≈ 235ms → 5000ms（>20×）
// 数值以测试运行输出为准；阈值刻意取宽，宁可在慢速 Windows runner 上不误报，也不想卡死。
//
// 隔离：FINALCHECK_SESSIONS_DIR / FINALCHECK_SESSION_STORE=sqlite 全部指向 os.tmpdir() 下的
// 临时目录，结束后 closeAllSessionDatabases() + rm -rf；不触碰用户真实项目数据。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readdir, rm, access } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../desktop/package.json', import.meta.url));
const Database = require('better-sqlite3');
const bs3Entry = require.resolve('better-sqlite3');
// 纯 Node 运行时必须显式加载 Node ABI 的 prebuilds-node 二进制（Electron 才用 build/Release）
const nodeBinding = path.join(path.dirname(bs3Entry), '..', 'prebuilds-node', 'better_sqlite3.node');

process.env.FINALCHECK_SESSION_STORE = 'sqlite'; // 强制生产后端
const root = await mkdtemp(path.join(os.tmpdir(), 'fc-perf-sessions-'));
process.env.FINALCHECK_SESSIONS_DIR = root;
const sessions = await import('../desktop/src/main/sessions.mjs');

after(async () => {
  sessions.closeAllSessionDatabases();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

// ---------- 阈值（见文件头依据） ----------
const LIST_FIRST_BUDGET_MS = 1500;
const LIST_WARM_BUDGET_MS = 300;
const LIST_BODY_RATIO = 2;        // 含 1MB 正文 vs 全短正文，耗时差异上限
const LIST_BODY_FLOOR_MS = 25;    // 计时噪声地板：两边都在 ~2ms 时 2× 只有 4ms，太容易被抖动击穿
const LOAD_1MB_BUDGET_MS = 800;
const MIGRATE_200_BUDGET_MS = 5000;

const dbIn = (dir) => path.join(dir, 'finalcheck.db');
const openRawFile = (file) => new Database(file, { nativeBinding: nodeBinding });

async function freshDir(t, prefix = 'fc-perf-one-') {
  const dir = await mkdtemp(path.join(root, prefix));
  process.env.FINALCHECK_SESSIONS_DIR = dir;
  t.after(async () => {
    sessions.closeAllSessionDatabases(); // Windows 下不关连接删不掉 db/wal/shm
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

async function measure(fn) {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function toolTrace(n = 5) {
  const out = [];
  for (let k = 0; k < n; k += 1) {
    out.push({ tool: 'read_file', args: JSON.stringify({ path: 'src/file-' + k + '.mjs' }), result: { added: k + 1, removed: 0 }, ms: 3 });
  }
  return out;
}

// 用真实写入路径造会话（避免绕过业务代码插入裸行，压测同时覆盖写入路径）
async function seedSessions(count, { toolEvery = 0, bigEvery = 0, bigBytes = 0 } = {}) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const s = await sessions.newSession('perf-' + i);
    await sessions.appendUserMessage(s.id, ('问题 ' + i + ' ').padEnd(120, 'q'));
    const trace = toolEvery > 0 && i % toolEvery === 0 ? toolTrace(5) : [];
    const content = bigEvery > 0 && i % bigEvery === 0
      ? 'x'.repeat(bigBytes)
      : ('回答 ' + i + ' ').padEnd(300, 'a');
    await sessions.appendAssistantMessage(s.id, { content, reasoning: 'r'.repeat(64), trace, workedMs: 5 });
    ids.push(s.id);
  }
  return ids;
}

test('列表性能：300 会话首次/热读耗时，且不随正文体积变化', async (t) => {
  const dir = await freshDir(t, 'fc-perf-list-');
  const ids = await seedSessions(300, { toolEvery: 10 }); // 30 个会话各 5 条 tool part
  assert.equal(ids.length, 300);
  sessions.closeAllSessionDatabases(); // 模拟冷启动：下一次 list 含打开库 + schema + 迁移扫描

  const first = await measure(() => sessions.listSessions());
  console.log('[perf] listSessions 首次（含打开库，300 会话）: ' + first.ms.toFixed(1) + 'ms（阈值 ' + LIST_FIRST_BUDGET_MS + 'ms）');
  assert.equal(first.value.length, 300, '300 个会话全部列出');
  assert.ok(first.ms < LIST_FIRST_BUDGET_MS, '首次列表 ' + first.ms.toFixed(1) + 'ms 超过 ' + LIST_FIRST_BUDGET_MS + 'ms');
  const withTools = first.value.find((x) => x.id === ids[0]);
  assert.ok(withTools, '带 tool part 的会话必须在列表里');
  assert.equal(withTools.turns, 1, '轮数来自 turns 元数据');
  assert.equal(withTools.path, dbIn(dir));
  assert.equal(first.value.find((x) => x.id === ids[299]).turns, 1);

  const second = await measure(() => sessions.listSessions());
  console.log('[perf] listSessions 二次（已打开）: ' + second.ms.toFixed(1) + 'ms（阈值 ' + LIST_WARM_BUDGET_MS + 'ms）');
  assert.ok(second.ms < LIST_WARM_BUDGET_MS, '热列表 ' + second.ms.toFixed(1) + 'ms 超过 ' + LIST_WARM_BUDGET_MS + 'ms');
  assert.equal(second.value.length, 300);

  // (c) 正文体积无关：同样的 300 会话，其中 38 条 assistant 正文为 1MB（其余短正文）。
  //     若 list 偷读消息体，38MB 正文的 JSON 解析会明显抬高耗时；交替跑 7 轮取中位数抵消抖动。
  const bigDir = await freshDir(t, 'fc-perf-list-big-');
  await seedSessions(300, { toolEvery: 10, bigEvery: 8, bigBytes: 1024 * 1024 });
  await sessions.listSessionsIn(bigDir); // 预热：打开库 + 完成迁移扫描（不计时）
  const shortRuns = [];
  const bigRuns = [];
  for (let i = 0; i < 7; i += 1) {
    shortRuns.push((await measure(() => sessions.listSessionsIn(dir))).ms);
    bigRuns.push((await measure(() => sessions.listSessionsIn(bigDir))).ms);
  }
  const shortMs = median(shortRuns);
  const bigMs = median(bigRuns);
  const bodyBudget = Math.max(shortMs * LIST_BODY_RATIO, LIST_BODY_FLOOR_MS);
  console.log('[perf] list 短正文中位数: ' + shortMs.toFixed(2) + 'ms；38 条 1MB 正文中位数: ' + bigMs.toFixed(2)
    + 'ms（上限 ' + bodyBudget.toFixed(2) + 'ms = max(' + LIST_BODY_RATIO + '×短正文, ' + LIST_BODY_FLOOR_MS + 'ms 噪声地板)）');
  assert.ok(bigMs < bodyBudget, '含 1MB 正文的列表耗时 ' + bigMs.toFixed(2) + 'ms 不应超过短正文 '
    + shortMs.toFixed(2) + 'ms 的 ' + LIST_BODY_RATIO + '×（地板 ' + LIST_BODY_FLOOR_MS + 'ms）：list 不应读取正文');
  const bigList = await sessions.listSessionsIn(bigDir);
  assert.equal(bigList.length, 300, '大正文库仍列出全部会话');
});

test('单会话打开：1MB 正文冷启动 < 800ms，且只返回该会话消息', async (t) => {
  const dir = await freshDir(t, 'fc-perf-load-');
  const noise = await seedSessions(99); // 其它会话做噪声，证明 load 只碰目标会话
  const target = await sessions.newSession('大正文会话');
  const big = 'x'.repeat(1024 * 1024); // 正好 1MB
  await sessions.appendUserMessage(target.id, '长正文请求');
  await sessions.appendAssistantMessage(target.id, { content: big, reasoning: 'y'.repeat(2048), trace: toolTrace(5), workedMs: 7 });
  sessions.closeAllSessionDatabases(); // 冷启动：含打开库

  const loaded = await measure(() => sessions.loadSession(target.id));
  console.log('[perf] loadSession 1MB 正文（冷启动，库内 100 会话）: ' + loaded.ms.toFixed(1) + 'ms（阈值 ' + LOAD_1MB_BUDGET_MS + 'ms）');
  assert.ok(loaded.ms < LOAD_1MB_BUDGET_MS, '1MB 会话打开 ' + loaded.ms.toFixed(1) + 'ms 超过 ' + LOAD_1MB_BUDGET_MS + 'ms');
  assert.equal(loaded.value.id, target.id);
  assert.equal(loaded.value.messages.length, 2, '只返回目标会话的 user+assistant 两条消息');
  assert.equal(loaded.value.messages[0].role, 'user');
  assert.equal(loaded.value.messages[0].content, '长正文请求');
  assert.equal(loaded.value.messages[1].role, 'assistant');
  assert.equal(loaded.value.messages[1].content.length, 1024 * 1024, '正文完整返回，不截断');
  assert.equal(loaded.value.messages[1].content, big);
  assert.equal(loaded.value.messages[1].trace.length, 5, '5 条 tool part 完整还原');
  assert.equal(noise.includes(loaded.value.id), false, '噪声会话不会混入返回结果');

  // 冷启动后再读一次（已打开），只做参考记录
  const warm = await measure(() => sessions.loadSession(target.id));
  console.log('[perf] loadSession 1MB 正文（热读）: ' + warm.ms.toFixed(1) + 'ms');
  assert.equal(warm.value.messages[1].content.length, 1024 * 1024);
  assert.equal(await access(dbIn(dir)).then(() => true, () => false), true, 'DB 落在本测试的临时目录内');
});

test('迁移性能：200 个旧 JSON 首次导入 < 5000ms，计数正确且旧文件不删', async (t) => {
  const project = await mkdtemp(path.join(root, 'fc-perf-mig-'));
  const dir = path.join(project, '.finalcheck', 'sessions'); // 生产目录形状：<项目>/.finalcheck/sessions
  await mkdir(dir, { recursive: true });
  process.env.FINALCHECK_SESSIONS_DIR = dir;
  t.after(async () => {
    sessions.closeAllSessionDatabases();
    await rm(project, { recursive: true, force: true }).catch(() => {});
  });

  const N = 200;
  for (let i = 0; i < N; i += 1) {
    const id = randomUUID();
    await writeFile(path.join(dir, 'session-' + id + '.json'), JSON.stringify({
      id,
      title: '旧会话 ' + i,
      createdAt: 1700000000000 + i,
      updatedAt: 1700000001000 + i,
      messages: [
        { role: 'user', content: '旧问题 ' + i, at: 1700000000000 + i },
        { role: 'assistant', content: '旧回答 ' + i + ' ' + 'a'.repeat(200), reasoning: '旧思考', trace: toolTrace(3), workedMs: 12, at: 1700000000500 + i },
        { role: 'notice', kind: 'compact', content: '旧提示', at: 1700000000900 + i },
      ],
    }), 'utf8');
  }
  const legacyBefore = (await readdir(dir)).filter((f) => f.startsWith('session-') && f.endsWith('.json')).sort();
  assert.equal(legacyBefore.length, N);

  sessions.closeAllSessionDatabases(); // 确保本次是首次打开（迁移只在 openDb 首次 ready 时触发）
  const first = await measure(() => sessions.listSessions());
  console.log('[perf] 首次迁移 200 个旧 JSON: ' + first.ms.toFixed(1) + 'ms（阈值 ' + MIGRATE_200_BUDGET_MS + 'ms）');
  assert.ok(first.ms < MIGRATE_200_BUDGET_MS, '首次迁移 ' + first.ms.toFixed(1) + 'ms 超过 ' + MIGRATE_200_BUDGET_MS + 'ms');
  assert.equal(first.value.length, N, '迁移后 200 个会话全部可见');
  assert.equal(first.value.find((x) => x.title === '旧会话 137').turns, 1);

  // 旧 JSON 只读导入：文件数量与文件名一个不少
  const legacyAfter = (await readdir(dir)).filter((f) => f.startsWith('session-') && f.endsWith('.json')).sort();
  assert.deepEqual(legacyAfter, legacyBefore, '旧 JSON 文件必须原样保留（数量与文件名不变）');

  // 直接查 DB：session 计数正确（DB 落在 <项目>/.finalcheck/finalcheck.db）
  const dbFile = path.join(project, '.finalcheck', 'finalcheck.db');
  const raw = openRawFile(dbFile);
  try {
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM session').get().n, N);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM message').get().n, N * 3);
  } finally { raw.close(); }

  // 下次启动重新打开：不重复导入（migrated:<id> 幂等标记）
  sessions.closeAllSessionDatabases();
  const second = await measure(() => sessions.listSessions());
  console.log('[perf] 重新打开（迁移已完成）: ' + second.ms.toFixed(1) + 'ms');
  assert.equal(second.value.length, N);
  const raw2 = openRawFile(dbFile);
  try {
    assert.equal(raw2.prepare('SELECT COUNT(*) AS n FROM session').get().n, N, '重复打开不能产生重复会话');
    assert.equal(raw2.prepare('SELECT COUNT(*) AS n FROM message').get().n, N * 3, '重复打开不能产生重复消息');
  } finally { raw2.close(); }
});
