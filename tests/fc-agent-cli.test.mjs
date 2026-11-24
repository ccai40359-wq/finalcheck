// 0.33.2 命令行 agent（bin/fc-agent.mjs）：子进程真跑，APPDATA/HOME 全指临时目录 + 假网关。
// 覆盖：写文件 + 回答输出；默认没人审批 → 被拒；--allow 规则放行；--output json；--resume 带上历史；计划模式只交计划。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startGateway } from '../scripts/sim/gateway.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fc-agent.mjs');

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
    p.stdin.end();
  });
}

test('fc-agent：-p 跑一轮、审批默认拒绝 / --allow 放行、json 输出、--resume 续聊、计划模式只交计划', { timeout: 120000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fc-cli-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const proj = path.join(root, 'proj');
  mkdirSync(path.join(appData, 'FinalCheck'), { recursive: true });
  mkdirSync(proj, { recursive: true });
  const seen = [];
  const gw = await startGateway({
    mode: 'script',
    respond: (body, { kind }) => {
      if (kind !== 'main') return null;
      seen.push(body);
      const last = body.messages[body.messages.length - 1];
      const users = body.messages.filter((m) => m.role === 'user').map((m) => String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
      const u = users.at(-1) || '';
      if (last.role === 'tool') return { content: `工具结果：${String(last.content).slice(0, 80)}` };
      if (u.includes('写文件')) return { toolCalls: [{ name: 'write_file', args: { path: 'cli-out.txt', content: 'hello from cli' } }] };
      if (u.includes('跑命令')) return { toolCalls: [{ name: 'run_command', args: { command: 'echo cli-ok' } }] };
      if (u.includes('出计划')) return { toolCalls: [{ name: 'exit_plan_mode', args: { plan: '## 计划\n1. 改 a.js：让 add 支持多个参数\n2. 跑 npm test 验证' } }] };
      if (u.includes('还记得')) return { content: `之前说过：${users.length} 条用户消息` };
      return { content: '你好，我是命令行。' };
    }
  });
  writeFileSync(path.join(appData, 'FinalCheck', 'config.json'), JSON.stringify({
    providers: [{ id: 'sim', name: 'Sim', baseUrl: gw.url, apiFormat: 'chat-completions', apiKey: 'sim-key', models: ['sim-model'], enabled: true }],
    activeProviderId: 'sim', activeModel: 'sim-model', language: 'zh', thinkingEffort: 'default'
  }));
  const env = { ...process.env, APPDATA: appData, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), USERPROFILE: home, HOME: home, FINALCHECK_TRIVY: 'off', FINALCHECK_SEMGREP: 'off' };
  for (const k of Object.keys(env)) if (k.startsWith('FINALCHECK_') && !['FINALCHECK_TRIVY', 'FINALCHECK_SEMGREP'].includes(k)) delete env[k];
  delete env.FC_AGENT_HOME;
  try {
    // 1) 没给权限：write_file 需要审批 → 被拒，文件不存在，回合正常结束
    const r1 = await run(['-p', '写文件', '--project', proj], env);
    assert.equal(r1.code, 0, r1.stderr);
    assert.ok(!existsSync(path.join(proj, 'cli-out.txt')), '没人审批不该写成');
    assert.match(r1.stderr, /需要审批，已拒绝：write_file/);
    assert.match(r1.stdout, /工具结果/);

    // 2) --allow 规则放行 + json 输出
    const r2 = await run(['-p', '写文件', '--project', proj, '--allow', 'write_file', '--output', 'json'], env);
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(readFileSync(path.join(proj, 'cli-out.txt'), 'utf8'), 'hello from cli');
    const j = JSON.parse(r2.stdout.trim().split('\n').at(-1));
    assert.equal(j.type, 'result');
    assert.deepEqual(j.tools, ['write_file']);
    assert.ok(j.sessionId);

    // 3) --resume：上一轮历史带上
    const r3 = await run(['-p', '还记得吗', '--project', proj, '--resume', j.sessionId, '--output', 'json'], env);
    const j3 = JSON.parse(r3.stdout.trim().split('\n').at(-1));
    assert.equal(j3.sessionId, j.sessionId);
    assert.match(j3.answer, /2 条用户消息/);

    // 4) --yes：run_command 直接跑
    const r4 = await run(['-p', '跑命令', '--project', proj, '--yes'], env);
    assert.equal(r4.code, 0, r4.stderr);
    assert.match(r4.stdout, /cli-ok/);

    // 5) 计划模式：没人批准 → 只打印计划、不报错
    const r5 = await run(['-p', '出计划', '--project', proj, '--plan'], env);
    assert.equal(r5.code, 0, r5.stderr);
    assert.match(r5.stdout, /计划（命令行模式没人批准，未执行）[\s\S]*改 a\.js/);

    // 隔离：CLI 的会话库在 cli/ 下，桌面端 config.json 没被改
    assert.ok(existsSync(path.join(appData, 'FinalCheck', 'cli', 'sessions')));
    assert.ok(!JSON.parse(readFileSync(path.join(appData, 'FinalCheck', 'config.json'), 'utf8')).permissionRules, '桌面端配置只读');

    // 参数错误
    assert.equal((await run(['-p'], env)).code, 2);
    assert.equal((await run(['--bogus'], env)).code, 2);
  } finally {
    await gw.close?.();
    rmSync(root, { recursive: true, force: true });
  }
});
