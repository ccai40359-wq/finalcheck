import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkInject } from '../src/checks/inject.mjs';

// S2 本地数据流回归：跨行变量/别名仍要报；同源相对 fetch 和固定主机 URL 不再误报 SSRF。
// 全部夹具在临时目录里真实落盘，不依赖 jsdom。

async function fixture(t, code) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fc-inject-flow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'app.js'), code);
  return root;
}

const byRule = (result, rule) => result.findings.filter((f) => f.rule === rule);
const highHits = (result, rule) => byRule(result, rule).filter((f) => f.severity === 'high');

/* ---------- 1) 本地变量/别名传播仍报正例 ---------- */

test('local flow: split-line SQL concat reports S2.sqli-concat at the query call', async (t) => {
  const root = await fixture(t, [
    "const sql = 'SELECT * FROM users WHERE id = ' + req.query.id;",
    'db.query(sql);',
  ].join('\n'));
  const r = await checkInject(root, { tier: 'L3' });
  const hits = byRule(r, 'S2.sqli-concat');
  assert.equal(hits.length, 1, `expected exactly one sqli finding, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].line, 2, 'finding must land on db.query(sql), not the assignment line');
  assert.equal(hits[0].severity, 'high', 'split-line SQL concat must stay high');
});

test('local flow: alias destination preserves R02 SSRF high', async (t) => {
  const root = await fixture(t, 'const destination=req.query.url;\nfetch(destination);\n');
  const r = await checkInject(root, { tier: 'L3' });
  const hits = highHits(r, 'S2.ssrf');
  assert.equal(hits.length, 1, `expected one high SSRF, got ${JSON.stringify(byRule(r, 'S2.ssrf'))}`);
  assert.equal(hits[0].line, 2, 'finding must land on fetch(destination)');
});

test('local flow: command injection through a local command variable stays high', async (t) => {
  const root = await fixture(t, [
    "const cmd = 'ping -c 1 ' + req.query.host;",
    'exec(cmd);',
  ].join('\n'));
  const r = await checkInject(root, { tier: 'L3' });
  const hits = byRule(r, 'S2.cmdi');
  assert.equal(hits.length, 1, `expected one cmdi finding, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].line, 2, 'finding must land on exec(cmd)');
  assert.equal(hits[0].severity, 'high');
});

test('local flow: path traversal through an alias stays high', async (t) => {
  const root = await fixture(t, [
    "const p = '/data/attachments/' + req.query.name;",
    'fs.readFile(p);',
  ].join('\n'));
  const r = await checkInject(root, { tier: 'L3' });
  const hits = byRule(r, 'S2.path-traversal');
  assert.equal(hits.length, 1, `expected one path-traversal finding, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].line, 2, 'finding must land on fs.readFile(p)');
  assert.equal(hits[0].severity, 'high');
});

test('local flow: path.join with a fixed prefix and req input still needs review', async (t) => {
  const root = await fixture(t, [
    "fs.readFile(path.join(__dirname, 'uploads', req.query.file));",
    "res.sendFile(path.join('/data', 'static.pdf'));",
    "fs.readFile('/data/static.pdf');",
  ].join('\n'));
  const r = await checkInject(root, { tier: 'L3' });
  const hits = byRule(r, 'S2.path-traversal');
  assert.equal(hits.length, 1, `expected only the req-driven join to report, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].line, 1, 'path.join prefix does not sanitize traversal');
  assert.equal(hits[0].severity, 'high');
  assert.ok(hits[0].message.includes('需复核'), 'path findings keep needs-review wording');
});

test('local flow: reflected XSS through a local html variable stays high', async (t) => {
  const root = await fixture(t, [
    'const html = \'<div class="preview">\' + req.query.html + \'</div>\';',
    'res.send(html);',
  ].join('\n'));
  const r = await checkInject(root, { tier: 'L3' });
  const hits = byRule(r, 'S2.reflected-xss');
  assert.equal(hits.length, 1, `expected one reflected-xss finding, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].line, 2, 'finding must land on res.send(html)');
  assert.equal(hits[0].severity, 'high');
});

test('local flow: escaped output is not reflected XSS', async (t) => {
  const root = await fixture(t, [
    'const safe = encodeURIComponent(req.query.q);',
    'res.send(safe);',
  ].join('\n'));
  const r = await checkInject(root, { tier: 'L3' });
  assert.deepEqual(byRule(r, 'S2.reflected-xss'), [], 'encodeURIComponent-wrapped input must not report');
});

/* ---------- 2) 不误报 ---------- */

test('parameterized queries are not flagged as SQL injection', async (t) => {
  const root = await fixture(t, [
    "db.query('SELECT * FROM users WHERE id = ?', [req.query.id]);",
    "db.query('SELECT * FROM users WHERE id = $1', [req.query.id]);",
  ].join('\n'));
  const r = await checkInject(root, { tier: 'L3' });
  assert.deepEqual(byRule(r, 'S2.sqli-concat'), [], 'placeholder parameters must not report');
});

test('LIKE concat inside the parameter array is not SQL injection', async (t) => {
  const root = await fixture(t, "db.query('SELECT * FROM t WHERE q LIKE ?', ['%' + req.query.q + '%']);\n");
  const r = await checkInject(root, { tier: 'L3' });
  assert.deepEqual(byRule(r, 'S2.sqli-concat'), [], 'concat in later args of a parameterized call must not report');
  assert.deepEqual(r.findings, [], 'no other S2 rule should fire on this parameterized call');
});

test('$1 and :name placeholders with concat params stay clean', async (t) => {
  const root = await fixture(t, [
    "db.query('SELECT * FROM t WHERE q LIKE $1', ['%' + req.query.q + '%']);",
    "db.query('SELECT * FROM t WHERE q LIKE :name', { name: '%' + req.query.q + '%' });",
  ].join('\n'));
  const r = await checkInject(root, { tier: 'L3' });
  assert.deepEqual(byRule(r, 'S2.sqli-concat'), [], '$1/:name placeholders must not be treated as SQL concat');
});

test('parameterized SQL held in a local alias still ignores concat params', async (t) => {
  const root = await fixture(t, "const sql = 'SELECT * FROM t WHERE q LIKE ?'; db.query(sql, ['%' + req.query.q + '%']);\n");
  const r = await checkInject(root, { tier: 'L3' });
  assert.deepEqual(byRule(r, 'S2.sqli-concat'), [], 'alias-resolved parameterized SQL must not report');
});

test('parameterized call still reports when the SQL first argument itself is concatenated', async (t) => {
  const root = await fixture(t, "db.query('SELECT * FROM t WHERE q = ' + req.query.q, ['%x%']);\n");
  const r = await checkInject(root, { tier: 'L3' });
  const hits = byRule(r, 'S2.sqli-concat');
  assert.equal(hits.length, 1, `expected one sqli finding, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].line, 1, 'finding must land on the concatenated SQL call');
  assert.equal(hits[0].severity, 'high', 'SQL first-arg concat must stay high even with a params array');
});

test('regex .exec is never reported as command injection', async (t) => {
  const root = await fixture(t, String.raw`const m = /^\s*resolved\s+"?(https?:[^"\s]+)"?/.exec(line);
const q = /x+y/.exec(text);
pattern.exec(req.query.value);
`);
  const r = await checkInject(root, { tier: 'L3' });
  assert.deepEqual(byRule(r, 'S2.cmdi'), [], '.exec on a regex literal or matcher must not report');
  assert.deepEqual(r.findings, [], 'no other S2 rule should fire on these regex lines');
});

test('real exec with concatenated req input still hits (positive control)', async (t) => {
  const root = await fixture(t, 'execSync("ping " + req.query.host);\n');
  const r = await checkInject(root, { tier: 'L3' });
  const hits = byRule(r, 'S2.cmdi');
  assert.equal(hits.length, 1, `positive control must report cmdi, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].line, 1);
});

/* ---------- 3) 同一 file+line+rule 去重 ---------- */

test('regex and local-flow hits on the same file+line+rule are deduplicated', async (t) => {
  const root = await fixture(t, [
    'fetch(req.query.url);',
    "db.query('SELECT * FROM users WHERE id = ' + req.query.id);",
    "res.send('<b>' + req.query.q + '</b>');",
    'exec("ping " + req.query.host);',
    "res.sendFile('/data/' + req.params.name);",
  ].join('\n'));
  const r = await checkInject(root, { tier: 'L3' });
  for (const [rule, line] of [
    ['S2.ssrf', 1],
    ['S2.sqli-concat', 2],
    ['S2.reflected-xss', 3],
    ['S2.cmdi', 4],
    ['S2.path-traversal', 5],
  ]) {
    const hits = byRule(r, rule);
    assert.equal(hits.length, 1, `${rule} must appear once, got ${JSON.stringify(hits)}`);
    assert.equal(hits[0].line, line, `${rule} must stay on its source line`);
  }
  assert.equal(r.findings.length, 5, 'no duplicate findings at all');
});

/* ---------- 4) SSRF 误报修复：同源相对 / 固定主机 ---------- */

const SSRF_NEGATIVES = [
  ['root-relative literal concat', "fetch('/api/' + req.query.id);"],
  ['root-relative template', 'fetch(`/api/${req.query.id}`);'],
  ['root-relative alias', "const p = '/api/' + req.query.id;\nfetch(p);"],
  ['dot-relative literal', "fetch('./relative/' + req.query.id);"],
  ['fixed absolute host', "fetch('https://api.example.com/items/' + req.query.id);"],
  ['fixed host alias', "const base = 'https://api.example.com/items/';\nfetch(base + req.query.id);"],
  ['nested relative alias', "const base = '/api/';\nconst p = base + req.query.id;\nfetch(p);"],
];

for (const [label, code] of SSRF_NEGATIVES) {
  test(`SSRF scope: ${label} is not high`, async (t) => {
    const root = await fixture(t, code + '\n');
    const r = await checkInject(root, { tier: 'L3' });
    assert.equal(highHits(r, 'S2.ssrf').length, 0, `${label} must not be high SSRF: ${JSON.stringify(byRule(r, 'S2.ssrf'))}`);
    assert.deepEqual(byRule(r, 'S2.ssrf'), [], `${label} is same-origin/fixed-host, no SSRF finding expected`);
  });
}

/* ---------- 5) SSRF 正例仍 high：主机可被请求输入改写 ---------- */

const SSRF_POSITIVES = [
  ['direct req url', 'fetch(req.query.url);', 1],
  ['alias req url', 'const u = req.query.url;\nfetch(u);', 2],
  ['template dynamic host', 'fetch(`https://${req.query.host}/x`);', 1],
  ['concat dynamic host', "fetch('https://' + req.query.host);", 1],
];

for (const [label, code, line] of SSRF_POSITIVES) {
  test(`SSRF positive: ${label} stays high`, async (t) => {
    const root = await fixture(t, code + '\n');
    const r = await checkInject(root, { tier: 'L3' });
    const hits = highHits(r, 'S2.ssrf');
    assert.equal(hits.length, 1, `${label} must report exactly one high SSRF, got ${JSON.stringify(byRule(r, 'S2.ssrf'))}`);
    assert.equal(hits[0].line, line, `${label} must land on the outbound call`);
    assert.equal(hits[0].severity, 'high', `${label} must stay high severity`);
  });
}
