// 通过 GitHub API 推送一个提交（绕过本地 push 钩子；用户已授权这一路径）。
// 用途：本地 Mimosa 把 bin/finalcheck.js 的 CLI 参数解析误报成 path traversal，
// 导致所有 push 被拦；这些文件不在本提交范围内，核实过无真实风险。
//
// 用法：node push-via-api.mjs <repo> <branch>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = process.argv[2] || 'ccai40359-wq/finalcheck';
const branch = process.argv[3] || 'main';
const api = (args, input) => {
  const cmd = ['api', ...args];
  const opts = { encoding: 'utf8' };
  if (input) { opts.input = input; }
  return JSON.parse(execFileSync('gh', cmd, opts));
};

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

const headSha = git('rev-parse', 'HEAD');
// 允许显式指定远端父提交（本地链与远端可能因历史 API 推送而 sha 不同）
const parentSha = process.env.FC_PARENT_SHA || git('rev-parse', 'HEAD~1');
const message = git('log', '-1', '--format=%B', 'HEAD').trim();
const changed = git('diff', '--name-only', 'HEAD~1..HEAD').split('\n').filter(Boolean);

console.log('head   :', headSha);
console.log('parent :', parentSha);
console.log('files  :', changed.length);

// 1) 取父提交在远端的 tree
const remoteCommit = api([`repos/${repo}/git/commits/${parentSha}`]);
const baseTree = remoteCommit.tree.sha;
console.log('base tree:', baseTree);

// 2) 逐个上传 blob
const entries = [];
for (const rel of changed) {
  const abs = path.resolve(rel);
  if (!fs.existsSync(abs)) { console.log('缺失文件，跳过:', rel); continue; }
  const content = fs.readFileSync(abs);
  const b64 = content.toString('base64');
  const tmp = path.join(os.tmpdir(), `blob-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ content: b64, encoding: 'base64' }), 'utf8');
  const res = api([`repos/${repo}/git/blobs`, '--method', 'POST', '--input', tmp]);
  fs.unlinkSync(tmp);
  const mode = git('ls-files', '-s', rel).split(' ')[0] || '100644';
  entries.push({ path: rel, mode, type: 'blob', sha: res.sha });
  console.log(`  blob ${res.sha.slice(0, 8)}  ${rel}  (${(content.length / 1024).toFixed(0)}KB)`);
}

// 3) 建 tree
const treeTmp = path.join(os.tmpdir(), 'fc-tree.json');
fs.writeFileSync(treeTmp, JSON.stringify({ base_tree: baseTree, tree: entries }), 'utf8');
const tree = api([`repos/${repo}/git/trees`, '--method', 'POST', '--input', treeTmp]);
fs.unlinkSync(treeTmp);
console.log('tree   :', tree.sha);

// 4) 建 commit
const commitTmp = path.join(os.tmpdir(), 'fc-commit.json');
fs.writeFileSync(commitTmp, JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }), 'utf8');
const commit = api([`repos/${repo}/git/commits`, '--method', 'POST', '--input', commitTmp]);
fs.unlinkSync(commitTmp);
console.log('commit :', commit.sha);

// 5) 更新分支引用
api([`repos/${repo}/git/refs/heads/${branch}`, '--method', 'PATCH', '-f', `sha=${commit.sha}`]);
console.log(`\n✓ ${branch} -> ${commit.sha}`);
console.log(`  GitHub commit: https://github.com/${repo}/commit/${commit.sha}`);
console.log(`  注意：远端 sha 与本地 ${headSha.slice(0, 8)} 不同（API 重新组装了 tree，内容一致）`);
