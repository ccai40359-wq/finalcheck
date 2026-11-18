// 2026-11-18：命令改道（读源码/搜代码 → read_file/grep_code）、audit 下一步建议、AI 看图链路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { shellReadRedirect } from '../desktop/src/main/shell-route.mjs';
import { auditNextSteps } from '../desktop/src/main/next-steps.mjs';
import { appendToolImages, runAgentTurn } from '../desktop/src/main/agent-service.mjs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';

test('shellReadRedirect：读源码 / 搜代码改道，E2E 里出现过的写法都能识别', () => {
  const read = [
    'cd /d/x && nl -ba src/app.js | sed -n "1,80p"',
    'cat server.js',
    'head -n 50 routes/app.js',
    "sed -n '10,40p' core/handler.py",
    'cd /d/x && echo "=== a ===" && nl -ba a.java && nl -ba b.java',
    'cat .htaccess 2>/dev/null',
  ];
  const search = [
    'grep -rn "secret" --include=*.js . | grep -v node_modules',
    'grep -n -A3 -E "<artifactId>(fastjson|xstream)" pom.xml',
    'cd /d/x && grep -rn "Interceptor\|Filter" src/main/java | head',
    'rg "password" src',
  ];
  for (const c of read) assert.equal(shellReadRedirect(c)?.kind, 'read', c);
  for (const c of search) assert.equal(shellReadRedirect(c)?.kind, 'search', c);
});

test('shellReadRedirect：正当用途放行（管道加工、日志、写文件、计数、spill 检索、git）', () => {
  const ok = [
    'ls -la && find . -name "*.py" | head -20',
    'git log --oneline | grep fix',
    'cat package.json | jq .dependencies',
    'tail -f server.log',
    'tail -20 /tmp/fc-build.log',
    'cat > out.txt <<EOF\nhi\nEOF',
    'grep -c "TODO" src/app.js',
    'grep -rl "eval(" src',
    'cd /d/x/spill && grep -n "S2" 1795.json',
    'npm test 2>&1 | tail -30',
    'wc -l src/*.js',
  ];
  for (const c of ok) assert.equal(shellReadRedirect(c), null, c);
});

test('auditNextSteps：高危发现指向具体方法论编号；大仓库建议工作流；有缺口提示 Not covered', () => {
  const r = {
    findings: [
      { checkId: 'S2', force: 'card', rule: 'S2.sg-java-sqli', file: 'A.java', line: 3 },
      { checkId: 'S2', force: 'card', rule: 'S2.mybatis-dollar', file: 'M.xml', line: 9 },
      { checkId: 'S2', force: 'card', rule: 'S2.sg-go-ssrf', file: 'h.go', line: 7 },
      { checkId: 'H1', force: 'tip', rule: 'H1.readme-missing', file: 'README.md', line: 0 },
    ],
    gates: { gaps: ['S1：…'] },
  };
  const steps = auditNextSteps(r, { dir: 'D:/p', codeFiles: 400, hasQualityConfig: true });
  const all = steps.join('\n');
  assert.match(all, /read_playbook\(topic="05"\)/);
  assert.match(all, /read_playbook\(topic="11"\)/);
  assert.match(all, /run_workflow/);
  assert.match(all, /quality_gate/);
  assert.match(all, /Not covered/);
  assert.match(all, /review_diff\(dir="D:\/p"\)/);
  assert.equal(auditNextSteps({ findings: [], gates: { gaps: [] } }, { codeFiles: 10 }).length, 0);
});

test('appendToolImages：未开视觉只给文字；开了就附图，且只保留最近 2 条图片消息', () => {
  const mk = (n) => [{ trace: { tool: 'view_image' }, images: [{ mime: 'image/png', base64: 'AAA' + n, label: `img${n}` }] }];
  const off = [];
  appendToolImages(off, mk(1), { vision: false });
  assert.equal(typeof off[0].content, 'string');
  assert.match(off[0].content, /没有开启视觉/);
  const convo = [];
  for (let i = 1; i <= 3; i++) appendToolImages(convo, mk(i), { vision: true });
  const withImg = convo.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  assert.equal(withImg.length, 2, '最早的一张图被替换成文字占位');
  assert.match(JSON.stringify(convo[0].content), /较早的图片已从上下文移除/);
  assert.equal(appendToolImages([], [{ trace: { tool: 'read_file' } }], { vision: true }), false);
});

test('view_image 端到端：图片作为 image_url 发给模型，工具 JSON 里不带 base64', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-vision-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const png = path.join(dir, 'a.png');
  writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'));
  const tools = createAgentTools({ repoRoot: path.resolve('.'), permissions: { sessionAllowed: () => true }, projectPath: dir });
  const bodies = [];
  let calls = 0;
  const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const fetchImpl = async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    calls++;
    if (calls === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'v1', function: { name: 'view_image', arguments: JSON.stringify({ path: png }) } }] } }] }]);
    return sse([{ choices: [{ delta: { content: '看到了' } }] }]);
  };
  const out = await runAgentTurn({ config: { baseUrl: 'https://mock/v1', apiKey: 'k', model: 'm', vision: true }, messages: [{ role: 'user', content: '看图' }], tools, fetchImpl });
  assert.match(out.answer, /看到了/);
  const second = bodies[1].messages;
  const toolMsg = second.find((m) => m.role === 'tool');
  assert.ok(!String(toolMsg.content).includes('base64') && !String(toolMsg.content).includes('__images'));
  const imgMsg = second.find((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  assert.ok(imgMsg, '下一次请求里应带 image_url');
  assert.match(imgMsg.content.find((p) => p.type === 'image_url').image_url.url, /^data:image\/png;base64,/);
});
