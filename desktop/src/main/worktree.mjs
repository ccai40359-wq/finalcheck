// worktree 隔离（0.33.1，对齐 Claude Code 子代理的 isolation: "worktree"）
// spawn_agent(type=general, isolation=worktree)：子代理在一个独立的 git worktree 里改文件，主工作区一个字节不动。
//   · 位置：<仓库根>/.finalcheck/worktrees/<id>（写进 .git/info/exclude，不污染 git status，不进提交）
//   · 分支：fc-agent/<id>，从当前 HEAD 拉出（注意：主工作区未提交的改动不在里面）
//   · 收尾：没改动 → 删 worktree + 分支；有改动 → 提交到分支、保留 worktree，把分支 / 路径 / diffstat 交回给主 agent
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const WT_DIR = path.join('.finalcheck', 'worktrees');

function git(args, cwd, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') || String(err?.message || '') });
    });
  });
}

const safeId = (id) => String(id || 'agent').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';

function ensureExcluded(top) {
  try {
    const info = path.join(top, '.git', 'info');
    if (!existsSync(path.join(top, '.git'))) return; // .git 是文件（本身就是 worktree / submodule）：不动
    mkdirSync(info, { recursive: true });
    const file = path.join(info, 'exclude');
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (!/^\/?\.finalcheck\/worktrees\/?$/m.test(cur)) appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}/.finalcheck/worktrees/\n`);
  } catch { /* 写不了 exclude 只是 git status 多一行，不阻断 */ }
}

/**
 * @returns {Promise<{ ok: true, top, dir, projectDir, branch, base } | { ok: false, error }>}
 */
export async function createAgentWorktree({ projectPath, id }) {
  if (!projectPath) return { ok: false, error: '没有项目目录，没法建 worktree' };
  const topR = await git(['rev-parse', '--show-toplevel'], projectPath);
  if (!topR.ok) return { ok: false, error: '项目不是 git 仓库，worktree 隔离用不了（去掉 isolation 或先 git init）' };
  const top = path.resolve(topR.stdout.trim());
  const baseR = await git(['rev-parse', 'HEAD'], top);
  if (!baseR.ok) return { ok: false, error: '仓库还没有任何提交，worktree 隔离用不了' };
  const base = baseR.stdout.trim();
  const sid = safeId(id);
  const branch = `fc-agent/${sid}`;
  const dir = path.join(top, WT_DIR, sid);
  ensureExcluded(top);
  const add = await git(['worktree', 'add', '-b', branch, dir, base], top);
  if (!add.ok) return { ok: false, error: `git worktree add 失败：${add.stderr.trim().slice(0, 400)}` };
  // 项目目录可能是仓库子目录：子代理的「项目根」对应到 worktree 里的同一子目录
  const rel = path.relative(top, path.resolve(projectPath));
  const projectDir = rel && !rel.startsWith('..') ? path.join(dir, rel) : dir;
  return { ok: true, top, dir, projectDir, branch, base };
}

/**
 * 收尾：有改动就提交到分支并保留；没改动就清理掉。
 * @returns {Promise<{ changed: boolean, kept: boolean, branch, dir?, commit?, diffstat?, files?, note? }>}
 */
export async function finishAgentWorktree(wt, { message = 'fc-agent changes' } = {}) {
  const { top, dir, branch, base } = wt;
  const status = await git(['status', '--porcelain'], dir);
  const dirty = status.ok && status.stdout.trim().length > 0;
  let note = '';
  if (dirty) {
    await git(['add', '-A'], dir);
    const ident = [];
    const name = await git(['config', 'user.name'], dir);
    if (!name.stdout.trim()) ident.push('-c', 'user.name=FinalCheck Agent');
    const mail = await git(['config', 'user.email'], dir);
    if (!mail.stdout.trim()) ident.push('-c', 'user.email=agent@finalcheck.local');
    const c = await git([...ident, 'commit', '-q', '-m', message], dir);
    if (!c.ok) note = `自动提交失败（改动留在 worktree 里未提交）：${c.stderr.trim().slice(0, 300)}`;
  }
  const head = (await git(['rev-parse', 'HEAD'], dir)).stdout.trim();
  const committed = head && head !== base;
  if (!dirty && !committed) {
    await git(['worktree', 'remove', '--force', dir], top);
    await git(['branch', '-D', branch], top);
    return { changed: false, kept: false, branch };
  }
  const range = `${base}..${head}`;
  const stat = committed ? (await git(['diff', '--stat', range], top)).stdout.trim() : (await git(['status', '--short'], dir)).stdout.trim();
  const files = committed ? (await git(['diff', '--name-only', range], top)).stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  return {
    changed: true,
    kept: true,
    branch,
    dir,
    commit: committed ? head : null,
    diffstat: stat.slice(0, 4000),
    files,
    ...(note ? { note } : {})
  };
}

/** 主 agent 收到的人话说明 */
export function worktreeSummary(res) {
  if (!res) return '';
  if (!res.changed) return '子代理在隔离 worktree 里没有改动任何文件，worktree 已清理。';
  return `子代理的改动在隔离分支 ${res.branch}（worktree：${res.dir}），主工作区没有被改。`
    + `看改动：git diff HEAD...${res.branch}；采纳：git merge ${res.branch}（或 cherry-pick）；不要了：git worktree remove --force "${res.dir}" && git branch -D ${res.branch}。`
    + (res.note ? ` 注意：${res.note}` : '');
}
