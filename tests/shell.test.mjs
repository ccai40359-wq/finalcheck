import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { isBlocked, runCommand } from '../desktop/src/main/shell.mjs';

test('shell: 灾难命令被拦截', () => {
  assert.equal(isBlocked('rm -rf /'), true);
  assert.equal(isBlocked('del /s /q C:\\'), true);
  assert.equal(isBlocked('shutdown /r'), true);
  assert.equal(isBlocked('dir D:\\'), false);
});

test('shell: echo 命令真实执行', async () => {
  const r = await runCommand('echo finalcheck-ok', { timeoutMs: 15000 });
  assert.equal(r.blocked, false);
  assert.match(r.stdout, /finalcheck-ok/);
});

test('shell: 拦截命令返回 blocked 标记', async () => {
  const r = await runCommand('rm -rf /');
  assert.equal(r.blocked, true);
  assert.match(r.stderr, /安全策略/);
});

test('shell: run_command 走 Git Bash（bash 语法可用，不再套 cmd）', { skip: process.platform !== 'win32' }, async (t) => {
  // 契约变更（决策 1，2026-11-16）：命令统一由 Git Bash 执行。
  // 早先这里测的是「cmd 的 find /c /v 要在 System32 下跑」——那是 cmd 时代的 PATH hack。
  // 现在断言 bash 语法能正常工作（换 shell 的核心收益：AI 写 bash 的出错率最低）。
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-shell-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'three.txt');
  await writeFile(file, 'a\nb\nc\n');
  const r = await runCommand(`wc -l "${file}" && cat "${file}"`, { timeoutMs: 15000 });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /three\.txt/i, 'wc 应报告文件名');
  assert.match(r.stdout, /3/, 'wc -l 应为 3 行');
});

test('shell: 超时会杀进程树并按时返回 124', async () => {
  const t0 = Date.now();
  const r = await runCommand('node -e "setTimeout(()=>{},9000)"', { timeoutMs: 3000 });
  assert.equal(r.code, 124);
  assert.ok(Date.now() - t0 < 7000, '不应等孙进程退出');
  assert.match(r.stderr, /超时/);
});
