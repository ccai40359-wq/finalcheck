// 0.33.1 worktree 隔离：建 → 无改动清理 / 有改动提交到分支、主工作区不动
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createAgentWorktree, finishAgentWorktree, worktreeSummary } from '../desktop/src/main/worktree.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });

test('worktree：无改动自动清理；有改动提交到 fc-agent 分支，主工作区不变', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'fc-wt-'));
  try {
    g(repo, 'init', '-q');
    g(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    writeFileSync(path.join(repo, 'a.txt'), 'main');
    const w1 = await createAgentWorktree({ projectPath: repo, id: 'one' });
    assert.ok(w1.ok, w1.error);
    const f1 = await finishAgentWorktree(w1);
    assert.equal(f1.changed, false);
    assert.ok(!existsSync(w1.dir));
    assert.equal(g(repo, 'branch', '--list', 'fc-agent/one').trim(), '');

    const w2 = await createAgentWorktree({ projectPath: repo, id: 'two' });
    writeFileSync(path.join(w2.dir, 'b.txt'), 'agent');
    const f2 = await finishAgentWorktree(w2, { message: 'fc-agent: test' });
    assert.equal(f2.changed, true);
    assert.deepEqual(f2.files, ['b.txt']);
    assert.ok(!existsSync(path.join(repo, 'b.txt')), '主工作区没被改');
    assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'main');
    assert.match(worktreeSummary(f2), /fc-agent\/two/);
    assert.ok(!g(repo, 'status', '--porcelain').includes('.finalcheck'), 'worktrees 目录被 exclude');
    assert.equal((await createAgentWorktree({ projectPath: os.tmpdir(), id: 'x' })).ok, false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
