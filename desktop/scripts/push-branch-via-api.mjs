// 把当前 worktree 的 HEAD 推到远端一个新分支（不碰 main）。
//
// 为什么不用 push-snapshot-via-api.mjs：那个脚本是「把本地工作区状态压成一次提交写到
// 远端 main」——会重写 main 的历史。这里要的是**独立分支**：
//   ① 取远端 main 作为 base（parent），保证与 main 是 fast-forward 关系、可开 PR
//   ② 比对 HEAD tree 与远端 main tree，只传差异 blob
//   ③ 建 tree(base=远端 main tree) → 建 commit(parent=远端 main) → POST 新 ref
// 用法：node desktop/scripts/push-branch-via-api.mjs <owner/repo> <newBranch> [baseBranch] [messageFile]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = process.argv[2] || 'ccai40359-wq/finalcheck';
const newBranch = process.argv[3];
const baseBranch = process.argv[4] || 'main';
const messageFile = process.argv[5] || null;
if (!newBranch) {
  console.error('用法: node push-branch-via-api.mjs <owner/repo> <newBranch> [baseBranch] [messageFile]');
  process.exit(1);
}

const api = (args, input) => {
  const opts = { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 };
  if (input) opts.input = input;
  return JSON.parse(execFileSync('gh', ['api', ...args], opts));
};
const git = (...a) => execFileSync('git', ['-c', 'core.quotepath=false', ...a], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();

// ① 远端 base
const remoteHead = api([`repos/${repo}/commits/${baseBranch}`]);
const parentSha = remoteHead.sha;
const baseTree = remoteHead.commit.tree.sha;
console.log('base branch :', baseBranch, parentSha);
console.log('base tree   :', baseTree);

// ② 本地 HEAD 的全部 tracked 文件
const lsTree = git('ls-tree', '-r', '--long', 'HEAD');
const localInfo = new Map();
for (const line of lsTree.split('\n')) {
  if (!line.trim()) continue;
  const tab = line.indexOf('\t');
  if (tab < 0) continue;
  const head = line.slice(0, tab).split(/\s+/);
  const rel = line.slice(tab + 1);
  localInfo.set(rel, { mode: head[0], sha: head[2] });
}
console.log('local files :', localInfo.size);

// ③ 远端 base tree（递归）
const remoteTree = api([`repos/${repo}/git/trees/${baseTree}?recursive=1`]);
if (remoteTree.truncated) {
  console.error('ERROR: 远端 tree 被截断（仓库过大），本脚本不适用；改用 git push');
  process.exit(2);
}
const remotePaths = new Map();
for (const e of remoteTree.tree || []) if (e.type === 'blob') remotePaths.set(e.path, e.sha);
console.log('base files  :', remotePaths.size);

// ④ 只上传差异 blob
const entries = [];
let uploaded = 0;
let deleted = 0;
for (const [rel, info] of localInfo) {
  if (info.sha === remotePaths.get(rel)) continue;
  const content = fs.readFileSync(path.resolve(rel));
  const tmp = path.join(os.tmpdir(), 'fc-b-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(tmp, JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }), 'utf8');
  const res = api([`repos/${repo}/git/blobs`, '--method', 'POST', '--input', tmp]);
  fs.unlinkSync(tmp);
  entries.push({ path: rel, mode: info.mode || '100644', type: 'blob', sha: res.sha });
  uploaded++;
}
for (const [rel] of remotePaths) {
  if (localInfo.has(rel)) continue;
  entries.push({ path: rel, mode: '100644', type: 'blob', sha: null }); // null = 删除
  deleted++;
}
console.log(`changed     : ${uploaded} added/modified, ${deleted} deleted`);

// ⑤ tree + commit
const treeTmp = path.join(os.tmpdir(), 'fc-t-' + Math.random().toString(36).slice(2) + '.json');
fs.writeFileSync(treeTmp, JSON.stringify({ base_tree: baseTree, tree: entries }), 'utf8');
const tree = api([`repos/${repo}/git/trees`, '--method', 'POST', '--input', treeTmp]);
fs.unlinkSync(treeTmp);

const message = messageFile
  ? fs.readFileSync(messageFile, 'utf8')
  : git('log', '-1', '--pretty=%B');
const commitTmp = path.join(os.tmpdir(), 'fc-c-' + Math.random().toString(36).slice(2) + '.json');
fs.writeFileSync(commitTmp, JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }), 'utf8');
const commit = api([`repos/${repo}/git/commits`, '--method', 'POST', '--input', commitTmp]);
fs.unlinkSync(commitTmp);
console.log('new commit  :', commit.sha);

// ⑥ 建新分支 ref（已存在则 PATCH）
let exists = true;
try { api([`repos/${repo}/git/ref/heads/${newBranch}`]); } catch { exists = false; }
if (exists) {
  api([`repos/${repo}/git/refs/heads/${newBranch}`, '--method', 'PATCH', '-f', `sha=${commit.sha}`, '-F', 'force=true']);
  console.log(`updated ${newBranch} -> ${commit.sha}`);
} else {
  api([`repos/${repo}/git/refs`, '--method', 'POST', '-f', `ref=refs/heads/${newBranch}`, '-f', `sha=${commit.sha}`]);
  console.log(`created ${newBranch} -> ${commit.sha}`);
}
console.log(`   https://github.com/${repo}/tree/${newBranch}`);
