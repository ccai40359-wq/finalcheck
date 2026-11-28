// 0.34.6 真实任务测试台：10 个真网关任务（开发 / 调研 / 规划 / GPU / 并发后台），自动评分。
// 用用户自己的 FC 网关配置（active provider），每个任务独立隔离环境（临时项目 + 独立会话）。
// 评分维度：完成与否（可断言的硬指标）+ spawn_agent 次数 + background 使用 + GPU 使用 + 耗时。
// 用法：node scripts/probe-real-tasks-0346.mjs [任务序号列表，如 1,7,8；缺省全部 10 个]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const OUT = 'D:/rcw-geo/.tmp/real-tasks-0346';
mkdirSync(OUT, { recursive: true });

// ---- 真实网关：从用户 FC 配置取 active provider（key 不打印）----
const userCfg = JSON.parse(readFileSync(path.join(process.env.APPDATA, 'FinalCheck', 'config.json'), 'utf8'));
const realProv = (userCfg.providers || []).find((p) => p.id === userCfg.activeProviderId)
  || (userCfg.providers || []).find((p) => p.enabled !== false && p.apiKey && p.baseUrl);
if (!realProv?.apiKey) { console.error('没有可用的真实网关配置'); process.exit(1); }
const REAL = { id: realProv.id, baseUrl: realProv.baseUrl, apiKey: realProv.apiKey };
const REAL_MODEL = realProv.models?.[0]?.id || 'deepseek-v4.1-flash-eco';
console.log(`[gateway] ${realProv.baseUrl} key=<已配置,长度${String(realProv.apiKey).length}> model=${REAL_MODEL}`);

// ---- 任务定义 ----
const LONG = '模块内容：导出函数与示例。'.repeat(30);
const TASKS = [
  {
    id: 1, name: '调研-三模块并行', files: {
      'src/a.js': 'export function add(a,b){return a+b}\n// A 模块：算术加法，被订单服务使用。\n' + LONG,
      'src/b.js': 'export function mul(a,b){return a*b}\n// B 模块：算术乘法，被报表服务使用。\n' + LONG,
      'src/c.js': 'export function fmt(n){return n.toFixed(2)}\n// C 模块：金额格式化，被收银台使用。\n' + LONG
    },
    prompt: '同时调研 src/ 里 a、b、c 三个模块各自导出什么、被谁使用——用多个子代理并行查（一条消息里全派出去），最后把三个模块汇总成一句话清单给我。',
    check: (t, dir) => {
      const spawns = t.trace.filter((x) => x.tool === 'spawn_agent').length;
      const ok = spawns >= 2 && /a.*模块|A 模块|add/.test(t.answer) && /c.*模块|C 模块|fmt/i.test(t.answer);
      return { ok, spawns, note: `spawn_agent=${spawns}` };
    }
  },
  {
    id: 2, name: '调研-鉴权机制', files: {
      'src/auth.js': 'const TOKEN = process.env.AUTH_TOKEN;\nexport function requireAuth(req,res,next){\n  const h = req.headers["authorization"]||"";\n  if (h !== "Bearer "+TOKEN) return res.status(401).json({error:"unauthorized"});\n  next();\n}\n// 鉴权：静态 Bearer Token，比对 Authorization 头。\n',
      'src/routes.js': 'import { requireAuth } from "./auth.js";\napp.get("/admin", requireAuth, (req,res)=>res.json({ok:true}));\napp.get("/public", (req,res)=>res.json({hello:"world"}));\n'
    },
    prompt: '这个项目的鉴权是怎么做的？哪些路由有保护、哪些没有？给出 文件:行 证据。',
    check: (t, dir) => {
      const spawns = t.trace.filter((x) => x.tool === 'spawn_agent').length;
      const ok = /Bearer|AUTH_TOKEN|authorization/i.test(t.answer) && /admin|public/i.test(t.answer);
      return { ok, spawns, note: `spawn_agent=${spawns}（单主题可派可不派）` };
    }
  },
  {
    id: 3, name: '规划-只给计划不动手', files: {
      'src/legacy.js': 'export function loadUser(id, cb){ setTimeout(()=>cb(null,{id,name:"u"}),10) }\nexport function loadOrder(id, cb){ setTimeout(()=>cb(null,{id,total:9}),10) }\n'
    },
    prompt: '给出把 src/legacy.js 从回调风格迁移到 async/await 的分步计划。先不要改任何代码，只给计划。',
    check: (t, dir) => {
      const wrote = t.trace.filter((x) => ['write_file', 'edit_file'].includes(x.tool)).length;
      const ok = wrote === 0 && /[1-9].*步|步骤|阶段/.test(t.answer) && /async|await|Promise/i.test(t.answer);
      return { ok, spawns: 0, note: `写文件=${wrote}（规划任务必须 0）` };
    }
  },
  {
    id: 4, name: '开发-修bug并验证', files: {
      'src/calc.js': 'export function sum(list){ let s=0; for (let i=0;i<list.length-1;i++) s+=list[i]; return s }\n'
    },
    prompt: 'src/calc.js 有 bug：sum([1,2,3]) 应该返回 6 但返回不对。修好它，并用 node 写个一次性验证证明修好了。',
    check: (t, dir) => {
      const code = readFileSync(path.join(dir, 'src/calc.js'), 'utf8');
      const ranNode = t.trace.some((x) => x.tool === 'run_command' && /node/.test(String(x.args)));
      const ok = /list\.length(?!-1)/.test(code) && ranNode;
      return { ok, spawns: 0, note: `bug修好=${/list\.length(?!-1)/.test(code)} 跑了验证=${ranNode}` };
    }
  },
  {
    id: 5, name: '开发-写码+测试', files: {},
    prompt: '写 src/wordcount.js 导出 wordCount(text)（按空白分词计数，中英混合按字符段算），再写 test-wordcount.js 用 node 直接断言至少 3 个用例并跑绿。',
    check: (t, dir) => {
      const has = existsSync(path.join(dir, 'src/wordcount.js'));
      const ranNode = t.trace.some((x) => x.tool === 'run_command' && /node[\s"']/.test(String(x.args)) && /test/.test(String(x.args)));
      const ok = has && ranNode;
      return { ok, spawns: 0, note: `文件=${has} 跑测试=${ranNode}` };
    }
  },
  {
    id: 6, name: 'GPU-识别与方案', files: {},
    prompt: '我要在本机跑本地 OCR 识别扫描件。先用 nvidia-smi 查这台机器的显卡型号和显存，然后告诉我：应该选什么 OCR 方案、装 GPU 版还是 CPU 版、为什么。不要装任何东西，只给结论。',
    check: (t, dir) => {
      const probed = t.trace.some((x) => x.tool === 'run_command' && /nvidia-smi/.test(String(x.args)));
      const ok = probed && /(3080|RTX|NVIDIA|N 卡)/i.test(t.answer) && /GPU|CUDA/i.test(t.answer) && /Paddle|Easy|Tesseract|OCR/i.test(t.answer);
      return { ok, spawns: 0, note: `查了显卡=${probed}` };
    }
  },
  {
    id: 7, name: 'GPU-实际转码', files: {}, special: 'video',
    prompt: '把项目里的 source.mp4 用显卡转码成 720p 的 out.mp4（有 N 卡就用 h264_nvenc，确认输出文件生成且能播）。转完告诉我用了 GPU 还是 CPU。',
    check: (t, dir) => {
      const out = path.join(dir, 'out.mp4');
      const exists = existsSync(out) && statSync(out).size > 10000;
      const nvenc = t.trace.some((x) => x.tool === 'run_command' && /nvenc/i.test(String(x.args)));
      const said = /GPU|nvenc|显卡/i.test(t.answer);
      return { ok: exists && nvenc, spawns: 0, note: `输出文件=${exists} 用了nvenc=${nvenc} 回答说了=${said}` };
    }
  },
  {
    id: 8, name: '并发-两个后台子代理', files: {
      'src/app.js': 'export function main(){return "app"}\nexport function helper(){return "help"}\nexport function util(){return "util"}\n',
      'README.md': '# 测试项目\n\n这是一个用于测试 FC 后台子代理的示例项目。README 描述了项目的用途与运行方式。\n'
    },
    prompt: '同时派两个后台子代理并行做：①统计 src/ 下每个文件的行数，写成 loc.txt；②读 README.md 写成 summary.txt（50 字以内）。两个都完成后把两个文件的内容汇总给我。',
    check: (t, dir) => {
      const bgSpawns = t.trace.filter((x) => x.tool === 'spawn_agent' && /background"?[: ]*true|"background":true/.test(String(x.args))).length;
      const loc = existsSync(path.join(dir, 'loc.txt'));
      const sum = existsSync(path.join(dir, 'summary.txt'));
      const ok = bgSpawns >= 1 && loc && sum;
      return { ok, spawns: bgSpawns, note: `后台子代理=${bgSpawns} loc.txt=${loc} summary.txt=${sum}` };
    }
  },
  {
    id: 9, name: '重构-拆函数', files: {
      'src/utils.js': 'export function formatAll(kind, value){\n  if (kind==="user") return "用户:" + String(value).toUpperCase();\n  if (kind==="order") return "订单#" + String(value).padStart(6,"0");\n  return String(value);\n}\n'
    },
    prompt: '把 src/utils.js 的 formatAll 拆成 formatUser 和 formatOrder 两个函数（行为完全不变），写个临时脚本对比拆分前后输出一致，确认后把临时脚本删掉。',
    check: (t, dir) => {
      const code = existsSync(path.join(dir, 'src/utils.js')) ? readFileSync(path.join(dir, 'src/utils.js'), 'utf8') : '';
      const ok = /formatUser/.test(code) && /formatOrder/.test(code);
      return { ok, spawns: 0, note: `拆分=${ok}` };
    }
  },
  {
    id: 10, name: '数据-统计月度', files: {}, special: 'csv',
    prompt: '统计 sales.csv 里 2026 年每个月的销售额合计，写成 summary.md（每月一行，格式「2026-01：xxx」）。写完抽查一个月的数字和源数据对一遍。',
    check: (t, dir) => {
      const f = path.join(dir, 'summary.md');
      const exists = existsSync(f);
      const body = exists ? readFileSync(f, 'utf8') : '';
      const ok = exists && /2026-0?1/.test(body) && /\d{2,}/.test(body);
      return { ok, spawns: 0, note: `summary.md=${exists}` };
    }
  }
];

// ---- 特殊夹具 ----
async function makeVideo(dir) {
  const src = path.join(dir, 'source.mp4');
  // 用 ffmpeg 生成 10 秒测试视频（本机有 ffmpeg）
  await new Promise((res) => {
    const p = spawn('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=10:size=1280x720:rate=24', '-pix_fmt', 'yuv420p', src], { stdio: 'ignore' });
    p.on('close', res); p.on('error', () => res());
  });
  return existsSync(src);
}
function makeCsv(dir) {
  // 2026 全年 365 行：date,amount（每月随机 28-31 行）
  let rows = ['date,amount'];
  const months = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let seed = 7;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  for (let m = 1; m <= 12; m++) {
    const base = m * 1000;
    for (let d = 1; d <= months[m - 1]; d++) rows.push(`2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')},${Math.round(base + rnd() * 500)}`);
  }
  writeFileSync(path.join(dir, 'sales.csv'), rows.join('\n'));
  return rows.slice(1).reduce((acc, l) => { const m = l.slice(5, 7); const v = Number(l.split(',')[1]); acc[m] = (acc[m] || 0) + v; return acc; }, {});
}

// ---- 跑 ----
const only = process.argv[2] ? process.argv[2].split(',').map(Number) : null;
const list = TASKS.filter((t) => !only || only.includes(t.id));
console.log(`[plan] ${list.length} 个真实任务，串行跑（真网关）\n`);
const scoreboard = [];


for (const task of list) {
  const dir = path.join(OUT, `task-${task.id}`);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  const userData = path.join(dir, 'user-data');
  const sessionsDir = path.join(dir, 'sessions');
  await mkdir(userData, { recursive: true }); await mkdir(sessionsDir, { recursive: true });

  process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
  const { createSimClient } = await import(pathToFileURL(path.join(root, 'scripts/sim/client.mjs')).href);
  const client = await createSimClient({
    label: `task-${task.id}`, root, project: { name: `task-${task.id}`, files: task.files || {} },
    gateway: { url: 'http://127.0.0.1:9', requests: [] },
    model: REAL_MODEL, apiKey: REAL.apiKey,
    config: {
      providers: [{ id: 'real', name: 'Real', baseUrl: REAL.baseUrl, apiFormat: 'chat-completions', apiKey: REAL.apiKey, models: [{ id: REAL_MODEL, contextWindow: 128000 }], enabled: true }],
      activeProviderId: 'real'
    },
    approvals: 'approve', logDir: path.join(OUT, `task-${task.id}-log`)
  });
  const projectDir = client.projectDir; // 引擎真正的工作区（夹具由 client 写入）
  let csvTruth = null;
  if (task.special === 'video') { const okv = await makeVideo(projectDir); console.log(`  [fixture] source.mp4=${okv}`); }
  if (task.special === 'csv') csvTruth = makeCsv(projectDir);

  console.log(`\n===== 任务 ${task.id}：${task.name} =====`);
  const t0 = Date.now();
  let turn = null;
  try {
    const sid = await client.newSession(`task-${task.id}`);
    turn = await Promise.race([
      client.send(sid, task.prompt),
      (async () => { await sleep(10 * 60 * 1000); return { answer: '', trace: [], timeout: true }; })()
    ]);
  } catch (e) {
    console.log(`  [error] ${String(e?.message || e).slice(0, 200)}`);
    scoreboard.push({ id: task.id, name: task.name, pass: false, note: '异常: ' + String(e?.message || e).slice(0, 120) });
    try { await client.close(); } catch { /* */ }
    continue;
  }
  const wallMs = Date.now() - t0;
  const answer = String(turn?.answer || '');
  const r = task.check(turn, projectDir);
  // 任务 10 抽查：1 月合计对源数据
  let spotCheck = '';
  if (task.id === 10 && csvTruth) {
    const expect = Math.round(csvTruth['01']);
    spotCheck = `1月真值=${expect}（写入 summary.md 的值须匹配，人工核）`;
  }
  const rec = { id: task.id, name: task.name, pass: !!r.ok, wallMs, spawns: r.spawns ?? 0, note: r.note + (spotCheck ? ' | ' + spotCheck : ''), answer: answer, timeout: !!turn?.timeout };
  scoreboard.push(rec);
  console.log(`  ${rec.pass ? '✓ PASS' : '✗ FAIL'} | ${wallMs / 1000 | 0}s | ${rec.note}`);
  console.log(`  回答头: ${answer.slice(0, 120).replace(/\n/g, ' ')}`);
  try { await client.close(); } catch { /* */ }
}

console.log('\n========== 计分板 ==========');
for (const r of scoreboard) console.log(`${r.pass ? '✓' : '✗'} [${r.id}] ${r.name} | ${(r.wallMs / 1000) | 0}s | ${r.note}`);
const passN = scoreboard.filter((r) => r.pass).length;
console.log(`\n通过 ${passN}/${scoreboard.length}`);
writeFileSync(path.join(OUT, 'scoreboard.json'), JSON.stringify(scoreboard, null, 2));
console.log('[saved]', path.join(OUT, 'scoreboard.json'));
process.exit(0);
