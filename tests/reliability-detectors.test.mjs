import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkAuthz } from '../src/checks/authz.mjs';
import { checkExternal } from '../src/checks/external.mjs';
import { checkPassword } from '../src/checks/password.mjs';
import { checkInject } from '../src/checks/inject.mjs';
import { extractRoutes } from '../src/extract-routes.mjs';
import { checkAuthCoverage } from '../src/checks/routes.mjs';
import { probeTarget } from '../src/dynamic/probe.mjs';

async function fixture(t, code) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fc-reliability-detectors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'app.js'), code);
  return root;
}
const express = "const express=require('express');\nconst app=express();\n";

test('owner evidence belongs to its own route, including named local handlers', async (t) => {
  const root = await fixture(t, express + "app.get('/orders/:id',(req,res)=>res.json(db.findOne({id:req.params.id})));\nconst mine=(req,res)=>res.json(db.findOne({userId:req.user.id}));\napp.get('/mine/:id',mine);\n");
  const result = await checkAuthz(root, { tier: 'L3', routeResult: await extractRoutes(root) });
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].snippet, /orders/);
});

test('webhook signature comments and unrelated routes do not suppress missing verifier', async (t) => {
  const root = await fixture(t, express + "app.post('/webhook/open',(req,res)=>res.json({ok:true}));\n// TODO: implement signature verification\napp.post('/webhook/safe',(req,res)=>{verifySignature(req);res.end();});\n");
  const hits = (await checkExternal(root, { tier: 'L3' })).findings.filter((f) => f.rule === 'S6.webhook-no-verify');
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /open/);
});

test('cookie attributes require actual secure values independently; local constants are resolved', async (t) => {
  const root = await fixture(t, "res.cookie('session',token,{httpOnly:false,secure:false,sameSite:false});\nres.cookie('session',token,{httpOnly:true});\nconst options={httpOnly:true,secure:true,sameSite:'lax'};\nres.cookie('session',token,options);\n");
  const hits = (await checkPassword(root, { tier: 'L3' })).findings;
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((f) => f.line), [1, 2]);
});

test('mutated cookie options and unparseable cookie sources cannot silently pass', async (t) => {
  const root = await fixture(t, "const options={httpOnly:true,secure:true,sameSite:'lax'};\noptions.secure=false;\nres.cookie('session',token,options);\n");
  assert.ok((await checkPassword(root, { tier: 'L3' })).findings.length > 0);
  await writeFile(path.join(root, 'app.js'), "res.cookie('session',token,{httpOnly:true,secure:true,sameSite:'lax'});\ninvalid @@ syntax");
  assert.ok((await checkPassword(root, { tier: 'L3' })).coverageGap);
});

test('unsupported HTTP framework is unavailable rather than not-applicable', async (t) => {
  const root = await fixture(t, "import Fastify from 'fastify';\nconst app=Fastify();\napp.get('/private/users',async()=>[]);\n");
  const routes = await extractRoutes(root);
  const result = await checkAuthCoverage(routes);
  assert.equal(result.gapKind, 'unavailable');
  assert.match(result.coverageGap, /支持|框架/);
});

test('a local auth-named function that only calls next is not accepted as a guard', async (t) => {
  const root = await fixture(t, express + "function requireAuth(req,res,next){next();}\napp.get('/private/users',requireAuth,(req,res)=>res.json([]));\n");
  const routes = await extractRoutes(root);
  assert.equal(routes.routes[0].hasGuard, false);
  const result = await checkAuthCoverage(routes);
  assert.ok(result.findings.some((f) => f.rule === 'S1.no-guard'));
});

test('simple local aliases preserve SQL/SSRF findings without flagging parameterized query', async (t) => {
  const root = await fixture(t, "const sql='SELECT * FROM users WHERE id='+req.query.id;\ndb.query(sql);\nconst destination=req.query.url;\nfetch(destination);\ndb.query('SELECT * FROM users WHERE id=?',[req.query.id]);\n");
  const hits = (await checkInject(root, { tier: 'L3' })).findings;
  assert.ok(hits.some((f) => f.rule === 'S2.sqli-concat' && f.line === 2));
  assert.ok(hits.some((f) => f.rule === 'S2.ssrf' && f.line === 4));
  assert.ok(!hits.some((f) => f.line === 5));
});

test('JSON business not-found responses are not reproduced vulnerabilities', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'not found', code: 404 }), { status: 200, headers: { 'content-type': 'application/json' } });
  try { assert.equal((await probeTarget('http://127.0.0.1:49199', { requests: 3 })).results.filter((r) => r.reproduced).length, 0); }
  finally { globalThis.fetch = original; }
});
