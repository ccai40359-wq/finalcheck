import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { HOOK_EVENTS, loadHooksConfig, runHookEvent } from '../desktop/src/main/hooks.mjs';

// ---- 测试用 hook 脚本（临时目录，node <script> 作为 command） ----
const hookDir = mkdtempSync(path.join(os.tmpdir(), 'fc-hooks-'));
after(() => rmSync(hookDir, { recursive: true, force: true }));

function writeHook(name, source) {
  const file = path.join(hookDir, name);
  writeFileSync(file, source, 'utf8');
  return file;
}

function hookCmd(name, extra = '') {
  const base = `"${process.execPath}" "${path.join(hookDir, name)}"`;
  return extra ? `${base} ${extra}` : base;
}

function writeConfig(name, body) {
  const file = path.join(hookDir, name);
  writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
  return file;
}

writeHook('deny.mjs', `
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ decision: 'deny', message: 'blocked-by-hook' }));
});
`);

writeHook('plain.mjs', `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('plain hook text');
});
`);

writeHook('sleep.mjs', `
setTimeout(() => {}, 5000);
`);

writeHook('exit3.mjs', `
process.exit(3);
`);

writeHook('flood.mjs', `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('x'.repeat(5000));
});
`);

writeHook('context1.mjs', `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ context: 'alpha' }));
});
`);

writeHook('context2.mjs', `
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let input = null;
  try { input = JSON.parse(raw); } catch { input = null; }
  const ok = input
    && input.hookContext === 'alpha'
    && input.sessionId === 's1'
    && input.tool === 'run_command'
    && input.cwd === process.argv[2];
  if (!ok) process.exit(4);
  process.stdout.write(JSON.stringify({ decision: 'allow', message: 'ctx-ok' }));
});
`);

writeHook('marker.mjs', `
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], 'ran');
`);

test('hooks: 未启用时不执行任何 hook（缺文件也按默认关闭）', async () => {
  const marker = path.join(hookDir, 'disabled-marker.txt');
  const cfg = loadHooksConfig(writeConfig('disabled.json', {
    enabled: false,
    events: { PreToolUse: [{ command: hookCmd('marker.mjs', `"${marker}"`) }] }
  }));
  const r = await runHookEvent('PreToolUse', {}, { config: cfg });
  assert.equal(r.ok, true);
  assert.equal(r.decision, 'allow');
  assert.equal(r.outputs.length, 0);
  assert.equal(existsSync(marker), false);

  const missing = loadHooksConfig(path.join(hookDir, 'definitely-missing.json'));
  assert.equal(missing.enabled, false);
  assert.deepEqual(Object.keys(missing.events), HOOK_EVENTS);
  assert.ok(missing.warnings.length >= 1);
});

test('hooks: 正常 hook 返回 deny + message', async () => {
  const cfg = loadHooksConfig(writeConfig('deny.json', {
    enabled: true,
    events: { PreToolUse: [{ command: hookCmd('deny.mjs'), matcher: '' }] }
  }));
  const r = await runHookEvent('PreToolUse', { sessionId: 's1' }, { config: cfg, cwd: hookDir });
  assert.equal(r.decision, 'deny');
  assert.deepEqual(r.messages, ['blocked-by-hook']);
  assert.equal(r.outputs.length, 1);
  assert.equal(r.outputs[0].event, 'PreToolUse');
  assert.equal(r.outputs[0].code, 0);
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('hooks: 非 JSON stdout 当 message，decision 不设（allow）', async () => {
  const cfg = loadHooksConfig(writeConfig('plain.json', {
    enabled: true,
    events: { PreToolUse: [{ command: hookCmd('plain.mjs') }] }
  }));
  const r = await runHookEvent('PreToolUse', { prompt: 'hi' }, { config: cfg, cwd: hookDir });
  assert.equal(r.decision, 'allow');
  assert.deepEqual(r.messages, ['plain hook text']);
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('hooks: 超时 → PreToolUse fail-closed deny；PostToolUse fail-open allow+warning', async () => {
  const cfg = loadHooksConfig(writeConfig('timeout.json', {
    enabled: true,
    timeoutMs: 1000,
    events: {
      PreToolUse: [{ command: hookCmd('sleep.mjs') }],
      PostToolUse: [{ command: hookCmd('sleep.mjs') }]
    }
  }));

  const t0 = Date.now();
  const pre = await runHookEvent('PreToolUse', {}, { config: cfg, cwd: hookDir });
  assert.equal(pre.decision, 'deny');
  assert.equal(pre.outputs[0].code, 124);
  assert.ok(pre.errors.length >= 1);
  assert.match(pre.errors[0], /超时/);
  assert.ok(Date.now() - t0 < 4000, '应在超时后尽快返回，不等 5s 的 hook');

  const post = await runHookEvent('PostToolUse', {}, { config: cfg, cwd: hookDir });
  assert.equal(post.decision, 'allow');
  assert.ok(post.warnings.length >= 1);
  assert.match(post.warnings[0], /fail-open/);
  assert.ok(post.errors.length >= 1);
  assert.equal(post.ok, false);
});

test('hooks: 退出码非 0 → PreToolUse deny；PostToolUse allow+warning', async () => {
  const cfg = loadHooksConfig(writeConfig('exit3.json', {
    enabled: true,
    events: {
      PreToolUse: [{ command: hookCmd('exit3.mjs') }],
      PostToolUseFailure: [{ command: hookCmd('exit3.mjs') }]
    }
  }));

  const pre = await runHookEvent('PreToolUse', {}, { config: cfg, cwd: hookDir });
  assert.equal(pre.decision, 'deny');
  assert.equal(pre.outputs[0].code, 3);
  assert.ok(pre.errors.length >= 1);
  assert.match(pre.errors[0], /退出码 3/);

  const post = await runHookEvent('PostToolUseFailure', {}, { config: cfg, cwd: hookDir });
  assert.equal(post.decision, 'allow');
  assert.ok(post.warnings.length >= 1);
  assert.ok(post.errors.length >= 1);
  assert.equal(post.ok, false);
});

test('hooks: 输出超过 maxOutputBytes 截断', async () => {
  const cfg = loadHooksConfig(writeConfig('flood.json', {
    enabled: true,
    maxOutputBytes: 1024,
    events: { PreToolUse: [{ command: hookCmd('flood.mjs') }] }
  }));
  const r = await runHookEvent('PreToolUse', {}, { config: cfg, cwd: hookDir });
  assert.equal(r.decision, 'allow');
  assert.equal(r.outputs.length, 1);
  assert.ok(r.outputs[0].stdout.length <= 1024, `stdout 长度 ${r.outputs[0].stdout.length} 应 <= 1024`);
  assert.ok(r.outputs[0].stdout.length >= 1000, '截断应保留接近上限的内容');
  assert.ok(r.messages[0].length <= 1024);
  assert.ok(r.warnings.some((w) => /截断/.test(w)));
});

test('hooks: 配置 clamp（timeoutMs 999999 → 600000；上下限）', () => {
  const high = loadHooksConfig(writeConfig('clamp-high.json', {
    enabled: true, timeoutMs: 999999, maxOutputBytes: 999999999, events: {}
  }));
  assert.equal(high.timeoutMs, 600000);
  assert.equal(high.maxOutputBytes, 1048576);

  const low = loadHooksConfig(writeConfig('clamp-low.json', {
    timeoutMs: 10, maxOutputBytes: 1
  }));
  assert.equal(low.timeoutMs, 1000);
  assert.equal(low.maxOutputBytes, 1024);
});

test('hooks: 上一个 hook 的 context 传给下一个的 hookContext', async () => {
  const cfg = loadHooksConfig(writeConfig('context.json', {
    enabled: true,
    events: {
      PreToolUse: [
        { command: hookCmd('context1.mjs') },
        { command: hookCmd('context2.mjs', `"${hookDir}"`) }
      ]
    }
  }));
  const r = await runHookEvent('PreToolUse', {
    sessionId: 's1', tool: 'run_command', args: { x: 1 }
  }, { config: cfg, cwd: hookDir });
  assert.equal(r.decision, 'allow');
  assert.deepEqual(r.messages, ['ctx-ok']);
  assert.equal(r.outputs.length, 2);
  assert.equal(r.context, 'alpha');
});

test('hooks: 未知事件名被丢弃并 warning；空 command 被丢弃', () => {
  const cfg = loadHooksConfig(writeConfig('unknown-event.json', {
    enabled: true,
    events: {
      PreToolUse: [
        { command: hookCmd('deny.mjs') },
        { command: '   ' }
      ],
      Notification: [{ command: hookCmd('deny.mjs') }]
    }
  }));
  assert.equal(cfg.events.Notification, undefined);
  assert.equal(cfg.events.PreToolUse.length, 1);
  assert.ok(cfg.warnings.some((w) => w.includes('Notification') && w.includes('未知')));
  assert.ok(cfg.warnings.some((w) => w.includes('缺少 command')));
});
