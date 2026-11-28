// 中性提示词探针：不提「并行 / 后台 / 子代理 / spawn」任何字眼，
// 看 FC 的 AI 会不会自己想到拆分 + 并行 + 后台（验证 SYSTEM_DEV_BASE 策略是否自发生效）。
import { mkdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const OUT = 'D:/rcw-geo/.tmp/neutral-tasks-0346';
mkdirSync(OUT, { recursive: true });

const userCfg = JSON.parse(readFileSync(path.join(process.env.APPDATA, 'FinalCheck', 'config.json'), 'utf8'));
const realProv = (userCfg.providers || []).find((p) => p.id === userCfg.activeProviderId)
  || (userCfg.providers || []).find((p) => p.enabled !== false && p.apiKey && p.baseUrl);
const REAL = { baseUrl: realProv.baseUrl, apiKey: realProv.apiKey };
const REAL_MODEL = realProv.models?.[0]?.id || 'deepseek-v4.1-flash-eco';

const TASKS = [ { id: 'M2', name: '中性中任务（8 模块真代码）', prompt: '帮我全面梳理这个项目：每个模块干什么、模块间怎么关联、有没有潜在风险或 bug，最后给一份改进建议清单。', files: {"src/orders.js":"const STATE = {}; \nexport function createOrder(id, items, user) {\n  if (!items || !items.length) throw new Error('empty cart');\n  const total = items.reduce((s, i) => s + i.price * i.qty, 0);\n  STATE[id] = { id, items, user, total, status: 'pending', createdAt: Date.now() };\n  return STATE[id];\n}\nexport function payOrder(id, channel) {\n  const o = STATE[id]; if (!o) throw new Error('no order');\n  if (o.status !== 'pending') throw new Error('bad state: ' + o.status);\n  o.status = 'paid'; o.channel = channel;\n  return o;\n}\nexport function cancelOrder(id, reason) {\n  const o = STATE[id]; if (!o) throw new Error('no order');\n  if (o.status === 'shipped') throw new Error('cannot cancel shipped');\n  o.status = 'cancelled'; o.cancelReason = reason;\n  return o;\n}\nexport function shipOrder(id) {\n  const o = STATE[id]; if (!o) throw new Error('no order');\n  if (o.status !== 'paid') throw new Error('must be paid first');\n  o.status = 'shipped'; o.shippedAt = Date.now();\n  return o;\n}\nexport function getOrder(id) { return STATE[id] || null; }\n","src/users.js":"const USERS = {};\nexport function register(name, email, password) {\n  if (!email.includes('@')) throw new Error('bad email');\n  if (USERS[email]) throw new Error('duplicate');\n  USERS[email] = { name, email, hash: Buffer.from(password).toString('base64'), createdAt: Date.now() };\n  return { email, name };\n}\nexport function login(email, password) {\n  const u = USERS[email]; if (!u) throw new Error('no user');\n  if (u.hash !== Buffer.from(password).toString('base64')) throw new Error('bad password');\n  return { email: u.email, name: u.name };\n}\nexport function profile(email) { return USERS[email] || null; }\n","src/payments.js":"const LEDGER = [];\nexport function chargeA(card, amount) {\n  if (!card || card.length < 8) throw new Error('invalid card');\n  const rec = { channel: 'A', card: card.slice(-4), amount, at: Date.now() };\n  LEDGER.push(rec); return rec;\n}\nexport function chargeB(token, amount) {\n  if (!token) throw new Error('missing token');\n  const rec = { channel: 'B', token, amount, at: Date.now() };\n  LEDGER.push(rec); return rec;\n}\nexport function refund(rec, amount) {\n  if (amount > rec.amount) throw new Error('refund > charge');\n  const r = { ...rec, refund: amount, at: Date.now() };\n  LEDGER.push(r); return r;\n}\nexport function ledger() { return [...LEDGER]; }\n","src/inventory.js":"const STOCK = {};\nexport function addSku(sku, qty) { STOCK[sku] = (STOCK[sku] || 0) + qty; return STOCK[sku]; }\nexport function reserve(sku, qty) {\n  const cur = STOCK[sku] || 0;\n  if (cur < qty) throw new Error('insufficient: ' + sku);\n  STOCK[sku] = cur - qty; return STOCK[sku];\n}\nexport function release(sku, qty) { STOCK[sku] = (STOCK[sku] || 0) + qty; return STOCK[sku]; }\nexport function stock(sku) { return STOCK[sku] || 0; }\n","src/reports.js":"import { ledger } from './payments.js';\nexport function dailyTotal(day) {\n  return ledger().filter((r) => new Date(r.at).toISOString().slice(0, 10) === day)\n    .reduce((s, r) => s + (r.amount || 0) - (r.refund || 0), 0);\n}\nexport function byChannel() {\n  const out = {};\n  for (const r of ledger()) out[r.channel] = (out[r.channel] || 0) + r.amount;\n  return out;\n}\nexport function csv() {\n  return ledger().map((r) => [r.at, r.channel, r.amount, r.refund || 0].join(',')).join('\n');\n}\n","src/webhooks.js":"const SEEN = new Set();\nexport function handleCallback(payload, signature) {\n  if (!payload || !payload.id) throw new Error('bad payload');\n  if (SEEN.has(payload.id)) return { deduped: true };\n  if (signature !== sign(payload)) throw new Error('bad signature');\n  SEEN.add(payload.id);\n  return { accepted: true, id: payload.id };\n}\nfunction sign(p) { return 'sig-' + p.id; }\n","src/jobs.js":"import { ledger } from './payments.js';\nconst JOBS = [];\nexport function register(name, fn, intervalMs) { JOBS.push({ name, fn, intervalMs, lastRun: 0 }); }\nexport function tick(now) {\n  const ran = [];\n  for (const j of JOBS) if (now - j.lastRun >= j.intervalMs) { j.fn(now); j.lastRun = now; ran.push(j.name); }\n  return ran;\n}\nexport function pendingCount() { return ledger().filter((r) => !r.refund && r.channel === 'B').length; }\n","src/router.js":"import * as orders from './orders.js';\nimport * as users from './users.js';\nimport * as payments from './payments.js';\nconst ROUTES = {\n  'POST /orders': orders.createOrder,\n  'POST /orders/pay': orders.payOrder,\n  'POST /users/register': users.register,\n  'POST /users/login': users.login,\n  'POST /pay/charge': payments.chargeA,\n  'GET /reports/by-channel': payments.byChannel,\n};\nexport function dispatch(route, payload) {\n  const fn = ROUTES[route]; if (!fn) throw new Error('no route: ' + route);\n  return fn(payload);\n}\n"} },
];

const scoreboard = [];

for (const task of TASKS) {
  const dir = path.join(OUT, task.id);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  const sessionsDir = path.join(dir, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
  const { createSimClient } = await import(pathToFileURL(path.join(root, 'scripts/sim/client.mjs')).href);
  const client = await createSimClient({
    label: task.id, root, project: { name: task.id, files: task.files },
    gateway: { url: 'http://127.0.0.1:9', requests: [] },
    model: REAL_MODEL, apiKey: REAL.apiKey,
    config: {
      providers: [{ id: 'real', name: 'Real', baseUrl: REAL.baseUrl, apiFormat: 'chat-completions', apiKey: REAL.apiKey, models: [{ id: REAL_MODEL, contextWindow: 128000 }], enabled: true }],
      activeProviderId: 'real'
    },
    approvals: 'approve', logDir: path.join(OUT, `${task.id}-log`)
  });
  const t0 = Date.now();
  const sid = await client.newSession(task.id);
  const turn = await Promise.race([
    client.send(sid, task.prompt),
    (async () => { await sleep(8 * 60 * 1000); return { answer: '', trace: [], timeout: true }; })()
  ]);
  const wallMs = Date.now() - t0;
  const trace = Array.isArray(turn?.trace) ? turn.trace : [];
  const spawns = trace.filter((x) => x.tool === 'spawn_agent');
  const bgSpawns = spawns.filter((x) => /background"?[: ]*true|"background":true/.test(String(x.args))).length;
  // 并行判定：同一批 tool-start 里出现 ≥2 个 spawn_agent（用事件的顺序不可靠，看 trace 里 spawn 的 args 时间戳没有——用子代理会话是否交叠来近似：trace 无法判，改用 engine 的并行证据 = 同回复多派。这里记录事实让人工判）
  const rec = {
    id: task.id, name: task.name, wallMs,
    spawnTotal: spawns.length, bgCount: bgSpawns,
    spawnPromptHeads: spawns.map((x) => { try { const a = typeof x.args === 'string' ? JSON.parse(x.args) : x.args; return String(a?.prompt || a?.task || '').slice(0, 60); } catch { return '?'; } }),
    answerHead: String(turn?.answer || '').slice(0, 300)
  };
  scoreboard.push(rec);
  console.log(`\n[${task.id}] ${task.name} | ${(wallMs / 1000) | 0}s | spawn=${rec.spawnTotal} (后台=${rec.bgCount})`);
  console.log('  派单内容:', JSON.stringify(rec.spawnPromptHeads));
  console.log('  回答头:', rec.answerHead.replace(/\n/g, ' ').slice(0, 200));
  // 顺手验证 N2 的 bug 真修了
  if (task.id === 'N2') {
    const a = existsSyncWrap(path.join(client.projectDir, 'src/a.js'));
    const b = existsSyncWrap(path.join(client.projectDir, 'src/b.js'));
    console.log('  a.js 修好后:', (a || '').slice(0, 120));
    console.log('  b.js 修好后:', (b || '').slice(0, 120));
  }
  function existsSyncWrap(p) { try { return readFileSync(p, 'utf8'); } catch { return '(不存在)'; } }
  try { await client.close(); } catch { /* */ }
}
writeFileSync(path.join(OUT, 'scoreboard.json'), JSON.stringify(scoreboard, null, 2));
console.log('\n[saved]', path.join(OUT, 'scoreboard.json'));
