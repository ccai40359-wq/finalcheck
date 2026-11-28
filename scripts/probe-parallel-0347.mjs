// 0.34.7 分工提速测试台：真实网关、中性提示词（题目里不提「并行 / 子代理 / 后台」），
// 看 FC 会不会自己分工、该串行的会不会硬拆、问问题会不会乱动手。
// 用法：FC_ROOT=<仓库根> FC_OUT=<输出目录> node scripts/probe-parallel-0347.mjs [题号,题号]
// 网关配置从用户 FC 配置里只读取（key 不打印）；每题独立临时项目 + 独立会话目录，不碰正在用的 FC。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.FC_ROOT ? path.resolve(process.env.FC_ROOT) : fileURLToPath(new URL('../', import.meta.url));
const OUT = process.env.FC_OUT || path.join(root, '.tmp', 'probe-parallel-0347');
mkdirSync(OUT, { recursive: true });

const userCfg = JSON.parse(readFileSync(path.join(process.env.APPDATA, 'FinalCheck', 'config.json'), 'utf8'));
const prov = (userCfg.providers || []).find((p) => p.id === userCfg.activeProviderId)
  || (userCfg.providers || []).find((p) => p.enabled !== false && p.apiKey && p.baseUrl);
if (!prov?.apiKey) { console.error('没有可用的网关配置'); process.exit(1); }
const MODEL = prov.models?.[0]?.id || 'deepseek-v4.1-flash-eco';
console.log(`[gateway] model=${MODEL} key=<已配置> root=${root}`);

// 8 个模块的小电商项目（zcode 0.34.6 中性题 M2 的同一份代码）
const SHOP = JSON.parse(readFileSync(new URL('./probe-parallel-0347.shop.json', import.meta.url), 'utf8'));
// 两个各要跑 ~15 秒的独立脚本：写下开始 / 结束时间，用来判断是不是同时跑的
const slowPy = (name) => `import time, json\nt0 = time.time()\ntime.sleep(15)\nopen('${name}.out.json', 'w').write(json.dumps({'name': '${name}', 'start': t0, 'end': time.time(), 'value': ${name === 'fetch_a' ? 41 : 1}}))\nprint('done ${name}')\n`;

const TASKS = [
  { id: 'M2', kind: 'split', name: '中任务-梳理 8 模块', files: SHOP,
    prompt: '帮我全面梳理这个项目：每个模块干什么、模块间怎么关联、有没有潜在风险或 bug，最后给一份改进建议清单。' },
  { id: 'P1', kind: 'split', name: '中任务-三个独立脚本', files: { 'data/words.txt': 'apple banana apple cherry banana apple\n', 'data/people.csv': 'name,age\nann,30\nbob,25\n' },
    prompt: '在 tools/ 下写三个脚本并各自跑一遍确认输出：① csv2json.py 把 data/people.csv 转成 data/people.json；② wordfreq.py 统计 data/words.txt 的词频写到 data/freq.json；③ fakeusers.py 生成 100 个随机用户写到 data/users.json。' },
  { id: 'P2', kind: 'parallel-cmd', name: '跑两个独立的慢脚本', files: { 'scripts/fetch_a.py': slowPy('fetch_a'), 'scripts/fetch_b.py': slowPy('fetch_b') },
    prompt: '运行 scripts/fetch_a.py 和 scripts/fetch_b.py（在项目根目录跑，每个大概要 15 秒），然后把两个输出文件里的 value 加起来写进 total.txt。' },
  { id: 'S1', kind: 'small', name: '小任务-修一个 bug', files: { 'src/calc.js': 'export function sum(a){ let s = 0; for (let i = 1; i < a.length; i++) s += a[i]; return s }\n' },
    prompt: 'src/calc.js 有 bug：sum([1,2,3]) 应该返回 6 但返回不对。修好它，并用 node 验证一下。' },
  { id: 'Q1', kind: 'ask', name: '提问-显卡能做什么', files: { 'README.md': '# demo\n' },
    prompt: '我这台电脑的显卡能用来做什么？简单说说。' },
  { id: 'G1', kind: 'ask', name: '提问-本地 OCR 选型', files: { 'README.md': '# demo\n' },
    prompt: '我想在本机跑本地 OCR 识别扫描件，用 CPU 还是显卡？推荐什么方案？简要回答。' }
];

const pick = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
const todo = pick.length ? TASKS.filter((t) => pick.includes(t.id)) : TASKS;
const board = [];

for (const task of todo) {
  const dir = path.join(OUT, task.id);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  const sessionsDir = path.join(dir, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
  const { createSimClient } = await import(pathToFileURL(path.join(root, 'scripts/sim/client.mjs')).href);
  const client = await createSimClient({
    label: task.id, root, project: { name: task.id, files: task.files },
    gateway: { url: 'http://127.0.0.1:9', requests: [] },
    model: MODEL, apiKey: prov.apiKey,
    config: {
      providers: [{ id: 'real', name: 'Real', baseUrl: prov.baseUrl, apiFormat: 'chat-completions', apiKey: prov.apiKey, models: [{ id: MODEL, contextWindow: 128000 }], enabled: true }],
      activeProviderId: 'real'
    },
    approvals: 'approve', logDir: path.join(OUT, `${task.id}-log`)
  });
  const t0 = Date.now();
  const sid = await client.newSession(task.id);
  const turn = await Promise.race([
    client.send(sid, task.prompt),
    (async () => { await sleep(10 * 60 * 1000); return { answer: '', trace: [], timeout: true }; })()
  ]);
  const wallMs = Date.now() - t0;
  const trace = Array.isArray(turn?.trace) ? turn.trace : [];
  const argsOf = (x) => { try { return typeof x.args === 'string' ? JSON.parse(x.args) : (x.args || {}); } catch { return {}; } };
  const spawns = trace.filter((x) => x.tool === 'spawn_agent');
  // 同一轮（round）里的 spawn_agent 个数的最大值 = 同时派出去的人数
  const perRound = new Map();
  for (const x of spawns) perRound.set(x.round, (perRound.get(x.round) || 0) + 1);
  const maxTogether = Math.max(0, ...perRound.values());
  const cmds = trace.filter((x) => x.tool === 'run_command');
  const parallelCmds = cmds.filter((x) => argsOf(x).parallel === true).length;
  const writes = trace.filter((x) => ['write_file', 'edit_file'].includes(x.tool)).length;
  const rec = { id: task.id, kind: task.kind, name: task.name, secs: Math.round(wallMs / 1000), tools: trace.length, spawns: spawns.length, maxTogether, parallelCmds, writes, answerChars: String(turn?.answer || '').length, timeout: !!turn?.timeout };
  if (task.id === 'P2') {
    try {
      const a = JSON.parse(readFileSync(path.join(client.projectDir, 'fetch_a.out.json'), 'utf8'));
      const b = JSON.parse(readFileSync(path.join(client.projectDir, 'fetch_b.out.json'), 'utf8'));
      rec.overlap = a.start < b.end && b.start < a.end;
      rec.total = readFileSync(path.join(client.projectDir, 'total.txt'), 'utf8').trim();
    } catch (e) { rec.p2err = String(e.message || e).slice(0, 80); }
  }
  if (task.id === 'P1') {
    rec.outputs = ['people.json', 'freq.json', 'users.json'].map((f) => { try { readFileSync(path.join(client.projectDir, 'data', f)); return 1; } catch { return 0; } }).join('');
  }
  if (task.kind === 'ask') rec.mentionsGpu = /3080|显卡|GPU|CUDA/i.test(String(turn?.answer || ''));
  rec.answerHead = String(turn?.answer || '').replace(/\s+/g, ' ').slice(0, 160);
  board.push(rec);
  console.log(`\n[${task.id}] ${task.name} | ${rec.secs}s | 工具 ${rec.tools} | spawn ${rec.spawns}（同时最多 ${maxTogether}）| parallel 命令 ${parallelCmds} | 写文件 ${writes}${rec.overlap !== undefined ? ` | 两脚本同时跑=${rec.overlap} total=${rec.total}` : ''}${rec.outputs ? ` | 产物=${rec.outputs}` : ''}`);
  console.log('  回答头:', rec.answerHead);
  try { await client.close(); } catch { /* */ }
}
writeFileSync(path.join(OUT, 'scoreboard.json'), JSON.stringify(board, null, 2));
console.log('\n[saved]', path.join(OUT, 'scoreboard.json'));
