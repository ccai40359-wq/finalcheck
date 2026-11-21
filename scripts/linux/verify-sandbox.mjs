// Linux 真机沙箱验证：装好 bubblewrap + socat 后跑：
//   node scripts/linux/verify-sandbox.mjs
// 配置构造与降级链已有 24 项单测盖着；这个脚本验的是「内核层真的拦住了」——
// 只有真机才能测出来的部分。
//
// A. wrapCommand 直连 bwrap —— 内核层隔离
//    · bwrap 能启动（AppArmor / userns 两类环境坑只有真机才暴露）
//    · 白名单内可写；白名单外只读（写 /etc、写 ~ 必须失败）
//    · denyRead 目录被 tmpfs 盖住（读隔离 —— Windows ACL 沙箱没有的能力）
//    · 网络白名单外被拦、白名单内放行（--unshare-net + 宿主代理）
//    · 附带校验：如果宿主上真出现了探针文件，说明沙箱根本没包住（比测试失败严重）
// B. FC 集成层：aclSandbox 开启时 run_command 真的走沙箱
//    · 命令执行成功且没有「降级宿主机」的 sandboxWarning
//    · 项目外路径仍被应用层闸先拦（防御纵深顺序：policy 在 bwrap 前面）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fails = [];
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : ' ' + detail}`);
  if (!ok) fails.push(label);
};

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function sh(command, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const p = spawn('/usr/bin/bash', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const t = setTimeout(() => {
      settled = true;
      try { p.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve({ code: 124, out, err: `${err}\n[timeout ${timeoutMs}ms]` });
    }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { if (!settled) { settled = true; clearTimeout(t); resolve({ code: -1, out, err: String(e?.message || e) }); } });
    p.on('close', (code) => { if (!settled) { settled = true; clearTimeout(t); resolve({ code, out, err }); } });
  });
}

// curl 的 %{http_code}：失败时通常写 000，但代理层 403 时 exit 0 也会写 403 ——
// 所以「被拦」= exit 非 0 或 http_code 不是 2xx，两个都要看。
const http2xxOf = (r) => /^2\d\d$/.test(String(r.out).trim());
const blockedOf = (r) => r.code !== 0 || !http2xxOf(r);

const { probeSandbox, buildSandboxConfig, wrapCommand, releaseSandbox } =
  await import(path.join(ROOT, 'desktop/src/main/sandbox-linux.mjs'));
// node:fs/promises 没有 exists（从 API 里移除了）；统一走 access
const existsOf = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

const home = os.homedir();
const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-sbx-verify-'));
// 测试专用 denyRead 哨兵：放在家目录下我们自己的目录里，不碰真实敏感目录
const denyDir = path.join(home, 'fc-deny-sbx');
await fs.mkdir(denyDir, { recursive: true });
await fs.writeFile(path.join(denyDir, 'fc-sentinel.txt'), 'SECRET-SENTINEL\n');
await fs.writeFile(path.join(projectDir, 'ok.txt'), 'inside\n');

try {
  const hasCurl = (await sh('command -v curl')).code === 0;
  if (!hasCurl) console.log('  [注意] 宿主机没有 curl，网络两项跳过（apt install curl 后重跑）');

  // ---------- A. 内核层 ----------
  console.log('== A. 内核层（wrapCommand 直连 bwrap）==');
  const probe = await probeSandbox();
  check(probe.available === true, 'probeSandbox available', JSON.stringify(probe));

  if (probe.available) {
    const cfg = buildSandboxConfig({});
    cfg.filesystem.denyRead = [...cfg.filesystem.denyRead, denyDir];
    cfg.filesystem.allowWrite = [...new Set([projectDir, ...cfg.filesystem.allowWrite])];
    const run = async (cmd, timeoutMs = 30000) => {
      const { command: wrappedCmd } = await wrapCommand({ command: cmd, cwd: projectDir, config: cfg, commandId: 'verify' });
      if (process.env.FC_DIAG === '1') console.log('[diag] wrapped =', JSON.stringify(String(wrappedCmd).slice(0, 500)));
      return sh(wrappedCmd, projectDir, timeoutMs);
    };

    // A1 bwrap 能启动（AppArmor / userns 问题在这里现形）
    const a1 = await run('echo SANDBOX_OK');
    check(a1.code === 0 && String(a1.out).includes('SANDBOX_OK'), '沙箱内命令能跑（bwrap 启动）',
      `code=${a1.code} err=${JSON.stringify(String(a1.err).slice(0, 300))}`);

    // A2 白名单内（项目目录）可写
    const a2 = await run('echo data > ok-written.txt');
    const a2file = await fs.readFile(path.join(projectDir, 'ok-written.txt'), 'utf8').catch(() => null);
    check(a2.code === 0 && a2file === 'data\n', '白名单内（项目目录）可写',
      `code=${a2.code} file=${JSON.stringify(a2file)} err=${JSON.stringify(String(a2.err).slice(0, 200))}`);

    // A3 白名单外只读：写 /etc 必须失败
    const a3 = await run('touch /etc/fc-sbx-probe');
    check(a3.code !== 0, '写 /etc 被拦（白名单外只读）',
      `code=${a3.code} err=${JSON.stringify(String(a3.err).slice(0, 200))}`);
    const hostEtcLeak = await existsOf('/etc/fc-sbx-probe');
    check(hostEtcLeak === false, '宿主 /etc 没被真写进去（沙箱确实包住了）', '宿主上出现了 /etc/fc-sbx-probe');

    // A4 白名单外只读：写 ~ 必须失败（~/.npm 等缓存目录在白名单里，家目录本身不在）
    const a4 = await run('touch ~/fc-sbx-host-probe');
    check(a4.code !== 0, '写 ~ 被拦（家目录不在写白名单）',
      `code=${a4.code} err=${JSON.stringify(String(a4.err).slice(0, 200))}`);
    const hostHomeLeak = await existsOf(path.join(home, 'fc-sbx-host-probe'));
    check(hostHomeLeak === false, '宿主家目录没被真写进去', '宿主上出现了 ~/fc-sbx-host-probe');
    await sh('rm -f ~/fc-sbx-host-probe');

    // A5 读隔离：denyRead 目录里的哨兵文件在沙箱里必须看不见（tmpfs 盖住）
    const a5 = await run(`cat ${denyDir}/fc-sentinel.txt`);
    check(a5.code !== 0 && !String(a5.out).includes('SECRET-SENTINEL'), 'denyRead 目录被读隔离（tmpfs）',
      `code=${a5.code} out=${JSON.stringify(String(a5.out).slice(0, 100))} err=${JSON.stringify(String(a5.err).slice(0, 200))}`);

    // A6 真 bash 在沙箱内（不是 dash）
    const a6 = await run("arr=(a b c); echo ${#arr[@]}");
    check(String(a6.out).trim() === '3', '沙箱内是真 bash（数组长度语法可用）',
      `out=${JSON.stringify(String(a6.out).slice(0, 60))} err=${JSON.stringify(String(a6.err).slice(0, 150))}`);

    if (hasCurl) {
      // 基线：宿主机能不能连 npm（连不上则白名单放行项无从谈起，只记基线不判失败）
      const h1 = await sh("curl -m 15 -sS -o /dev/null -w '%{http_code}' https://registry.npmjs.org/-/ping", home, 25000);
      console.log(`  [基线] 宿主机 npm ping → http_code=${String(h1.out).trim()} code=${h1.code}`);

      // A7 网络白名单外：example.com 必须被拦
      const a7 = await run("curl -m 8 -sS -o /dev/null -w '%{http_code}' https://example.com", 20000);
      check(blockedOf(a7), '网络白名单外被拦（example.com）',
        `code=${a7.code} http=${JSON.stringify(String(a7.out).slice(0, 40))} err=${JSON.stringify(String(a7.err).slice(0, 200))}`);

      // A8 网络白名单内：npm registry 放行
      const a8 = await run("curl -m 20 -sS -o /dev/null -w '%{http_code}' https://registry.npmjs.org/-/ping", 30000);
      check(a8.code === 0 && http2xxOf(a8), '网络白名单内放行（registry.npmjs.org）',
        `code=${a8.code} http=${JSON.stringify(String(a8.out).slice(0, 40))} err=${JSON.stringify(String(a8.err).slice(0, 300))}`);
    }

    await releaseSandbox(); // A/B 两段配置不同，initialize 会判冲突，中间必须 reset
  }

  // ---------- B. FC 集成层 ----------
  console.log('== B. FC 集成层（run_command + aclSandbox）==');
  process.env.FINALCHECK_ACL_SANDBOX = 'on';
  const { createAgentTools } = await import(path.join(ROOT, 'desktop/src/main/agent-tools.mjs'));
  const { createPolicy } = await import(path.join(ROOT, 'desktop/src/main/policy.mjs'));
  const { ensureLinuxSandboxProbe } = await import(path.join(ROOT, 'desktop/src/main/sandbox.mjs'));
  const probe2 = await ensureLinuxSandboxProbe();
  check(probe2.available === true, 'ensureLinuxSandboxProbe available', JSON.stringify(probe2));

  const tools = createAgentTools({
    repoRoot: projectDir,
    projectPath: projectDir,
    policy: createPolicy({ projectPath: projectDir, mode: 'workspace' }),
    permissions: { requestApproval: async () => 'allowed-once' },
    recordAudit: async () => {},
    aclSandbox: true,
    sandboxCfg: {}
  });

  const b1 = await tools.run_command({ command: 'echo INTEGRATION_OK' });
  check(!b1.error && String(b1.stdout || '').includes('INTEGRATION_OK') && !b1.sandboxWarning && !b1.sandboxSkip,
    'run_command 走沙箱且无降级警告',
    JSON.stringify({ error: b1.error, w: b1.sandboxWarning, s: b1.sandboxSkip, err: String(b1.stderr || '').slice(0, 200) }));

  // 应用层闸在沙箱前面：项目外路径根本不该进 bwrap
  const b2 = await tools.run_command({ command: 'cat /etc/passwd' });
  check(!!b2.deniedBy, '项目外路径先被应用层闸拦（防御纵深顺序）', String(b2.deniedBy || 'none'));
} finally {
  await releaseSandbox().catch(() => {});
  await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(denyDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n===== ${fails.length === 0 ? 'PASS' : 'FAIL ' + fails.length} =====`);
if (fails.length) process.exitCode = 1;
