import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { listTextFiles } from '../walk.mjs';
import { runProcess } from '../run-async.mjs';

// Q1 测试真跑（ACCEPTANCE §4-C）：不认"写了测试"认"npm test 绿"；L2 加写接口测试引用检查
async function npmTest(projectDir) {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) return { error: new Error('npm-cli.js 未找到') };
  return runProcess(process.execPath, [npmCli, 'test'], { cwd: projectDir, timeoutMs: 180000 });
}

export async function checkQ1(projectDir, { tier, excludes = [], routeResult = null, run = true } = {}) {
  const findings = [];
  const warnings = [];
  const force = tier === 'L1' ? 'tip' : 'card';
  try {
    const pkg = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    if (!pkg.scripts?.test) {
      findings.push({ checkId: 'Q1', severity: 'medium', force, file: 'package.json', line: 0, rule: 'Q1.no-tests', snippet: '无 test 脚本', message: '项目没有测试脚本（npm test 不可用）', source: 'program' });
      return { checkId: 'Q1', findings, coverageGap: null, warnings };
    }
  } catch {
    // 没有 package.json = 本机没东西可跑（能力缺失），不是「用户没点头」
    return { checkId: 'Q1', findings, coverageGap: '无 package.json，Q1 跳过', warnings };
  }
  // §7：外部项目禁跑被审代码的测试 → 记缺口，绝不因为「没跑」而当成通过
  // gapKind=unauthorized：只是等授权，别把整份结论压成「无法验收」/「拦」
  if (!run) return { checkId: 'Q1', findings, coverageGap: 'Q1：未授权执行测试（runTests=false），测试关未跑', gapKind: 'unauthorized', warnings };

  const runRes = await npmTest(projectDir);
  if (runRes.error) {
    warnings.push(`npm test 运行失败：${runRes.error.code || 'error'}（计覆盖不足）`);
    return { checkId: 'Q1', findings, coverageGap: 'npm test 无法运行', warnings };
  }
  if (runRes.status !== 0) {
    const tail = String(runRes.stderr || runRes.stdout || '').trim().split('\n').slice(-5).join(' | ').slice(0, 280);
    findings.push({ checkId: 'Q1', severity: 'medium', force, file: '(npm test)', line: 0, rule: 'Q1.tests-fail', snippet: `npm test 退出码 ${runRes.status}：${tail}`, message: '测试未全绿', source: 'program' });
  }

  // L2 写接口（POST/PUT/PATCH/DELETE）必须在测试文件中有引用
  if (tier !== 'L1' && routeResult?.routes?.length) {
    const { files } = await listTextFiles(projectDir, excludes);
    const testFiles = files.filter((f) => /\.(test|spec)\.[cm]?jsx?$/i.test(f) || /[\\/](tests?|__tests__)[\\/]/i.test(f));
    let corpus = '';
    for (const f of testFiles) { try { corpus += readFileSync(f, 'utf8') + '\n'; } catch { /* 忽略不可读 */ } }
    for (const r of routeResult.routes) {
      if (!['post', 'put', 'patch', 'delete'].includes(r.method)) continue;
      const literal = r.path.replace(/:[^/]+/g, '').replace(/\/{2,}/g, '/'); // 双斜杠归一 + 根路径跳过（三轮 P2#11）
      if (literal && literal !== '/' && !corpus.includes(literal)) {
        findings.push({ checkId: 'Q1', severity: 'medium', force, file: r.file, line: r.line, rule: 'Q1.write-route-untested', snippet: `${r.method.toUpperCase()} ${r.path}`, message: '写接口在测试文件中零引用——若无请补测试，若有请反馈误报', source: 'program' });
      }
    }
  }
  if (tier === 'L3') warnings.push('L3 覆盖率门槛（≥40%）需接入 c8，本轮未实现');
  return { checkId: 'Q1', findings, coverageGap: null, warnings };
}
