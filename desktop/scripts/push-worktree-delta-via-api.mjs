// 把工作区相对 HEAD 的改动，作为一个新提交追加到远端某个分支的顶端。
//
// 与 push-branch-via-api.mjs 的区别：那个以远端 main 为 base（parent=main）；
// 这一个以**指定远端分支的当前 head** 为 parent —— 用于在已有 PR 分支上追加提交，
// 不去重写、也不碰 main。
//
// 做法：
//   ① 取远端分支 head 的 tree 与 sha（作为 base 与 parent）
//   ② 比对「本地 HEAD 里 tracked 文件的 blob sha」与远端 tree，只上传差异 blob
//      （工作区已被 patch 改过的文件，用 hash-object 计算新 sha，不依赖 git add）
//   ③ 建 tree(base_tree=远端分支 tree) → 建 commit(parents=[远端分支 head])
//   ④ PATCH 该分支 ref
//
// 用法：node desktop/scripts/push-worktree-delta-via-api.mjs <owner/repo> <branch> <messageFile>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = process.argv[2] || 'ccai40359-wq/finalcheck';
const branch = process.argv[3];
const messageFile = process.argv[4] || null;
if (!branch) {
  console.error('用法: node push-worktree-delta-via-api.mjs <owner/repo> <branch> <messageFile>');
  process.exit(1);
}

const api = (args, input) => {
  const opts = { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 };
  if (input) opts.input = input;
  return JSON.parse(execFileSync('gh', ['api', ...args], opts));
};
const git = (...a) => execFileSync('git', ['-c', 'core.quotepath=false', ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();

// ① 远端分支当前 head
const remoteHead = api([`repos/${repo}/commits/${branch}`]);
const parentSha = remoteHead.sha;
const baseTree = remoteHead.commit.tree.sha;
console.log('branch      :', branch, parentSha);
console.log('base tree   :', baseTree);

// ② 本地 HEAD 的 tracked 文件 + 工作区现状（工作区改了但没 commit 也要算进来）
const lsTree = git('ls-tree', '-r', '--long', 'HEAD');
const headInfo = new Map();
for (const line of lsTree.split('\n')) {
  if (!line.trim()) continue;
  const tab = line.indexOf('\t');
  if (tab < 0) continue;
  const meta = line.slice(0, tab).split(/\s+/);
  headInfo.set(line.slice(tab + 1), { mode: meta[0], sha: meta[2] });
}

// 工作区里相对 HEAD 有改动/新增的文件（不信任 index，直接比 hash-object 与 HEAD blob）
const statusOut = git('status', '--porcelain', '-z');
const touched = [];
for (const entry of statusOut.split('\0')) {
  if (!entry) continue;
  const st = entry.slice(0, 2);
  let rel = entry.slice(3);
  if (st.includes('R')) rel = rel.split('\0').pop() || rel; // rename 取新路径
  if (!rel) continue;
  if (st === '??' || st.trim()) touched.push(rel);
}
console.log('touched     :', touched.length);

const remoteTree = api([`repos/${repo}/git/trees/${baseTree}?recursive=1`]);
if (remoteTree.truncated) {
  console.error('ERROR: 远端 tree 被截断，脚本不适用');
  process.exit(2);
}
const remotePaths = new Map();
for (const e of remoteTree.tree || []) if (e.type === 'blob') remotePaths.set(e.path, e.sha);

// ② 只处理本次改动过的文件：其它文件分支上已有，不动。
//    （不能用「HEAD blob sha 直接引用」——远端是不同历史，那些 blob 在 GitHub 上不存在，
//      tree 接口会报 "not a valid blob"。只有本次上传的 blob 才能引用。）
const entries = [];
let uploaded = 0;
for (const rel of touched) {
  if (!fs.existsSync(path.resolve(rel))) {
    entries.push({ path: rel, mode: '100644', type: 'blob', sha: null }); // 删掉
    continue;
  }
  const content = fs.readFileSync(path.resolve(rel));
  const tmp = path.join(os.tmpdir(), 'fc-b-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(tmp, JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }), 'utf8');
  const res = api([`repos/${repo}/git/blobs`, '--method', 'POST', '--input', tmp]);
  fs.unlinkSync(tmp);
  const mode = headInfo.get(rel)?.mode || '100644';
  entries.push({ path: rel, mode, type: 'blob', sha: res.sha });
  uploaded++;
}
// 分支上有、本地 HEAD 里已不存在的文件 → 删除（本次改动确实删掉的）
let deleted = 0;
for (const [rel] of remotePaths) {
  if (headInfo.has(rel)) continue;
  entries.push({ path: rel, mode: '100644', type: 'blob', sha: null });
  deleted++;
}
console.log(`changed     : ${uploaded} uploaded, ${deleted} deleted`);

if (!entries.length) { console.log('无差异，跳过'); process.exit(0); }

// ③ tree + commit
const treeTmp = path.join(os.tmpdir(), 'fc-t-' + Math.random().toString(36).slice(2) + '.json');
fs.writeFileSync(treeTmp, JSON.stringify({ base_tree: baseTree, tree: entries }), 'utf8');
const tree = api([`repos/${repo}/git/trees`, '--method', 'POST', '--input', treeTmp]);
fs.unlinkSync(treeTmp);
console.log('new tree    :', tree.sha);

const message = messageFile ? fs.readFileSync(messageFile, 'utf8') : git('log', '-1', '--pretty=%B');
const commitTmp = path.join(os.tmpdir(), 'fc-c-' + Math.random().toString(36).slice(2) + '.json');
fs.writeFileSync(commitTmp, JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }), 'utf8');
const commit = api([`repos/${repo}/git/commits`, '--method', 'POST', '--input', commitTmp]);
fs.unlinkSync(commitTmp);
console.log('new commit  :', commit.sha);

api([`repos/${repo}/git/refs/heads/${branch}`, '--method', 'PATCH', '-f', `sha=${commit.sha}`]);
console.log(`\nOK ${branch} -> ${commit.sha}`);
console.log(`   https://github.com/${repo}/tree/${branch}`);
