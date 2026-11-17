// 把本地 HEAD 与远端 main 的全部差异一次性推上去（squash 成一个提交）。
// 用途：本地有多个未推送提交，而 push-via-api.mjs 只处理 HEAD 单个提交。
//
// 做法：
//   ① 用 gh api 拉远端 main 的 tree
//   ② 比对「本地 HEAD 的全部 tracked 文件」与「远端 tree」——只上传不同的/新增的，标记删除的
//   ③ 建 tree（base_tree = 远端 tree）→ 建 commit（parent = 远端 main）→ PATCH ref
// 这是「把工作区状态以一次提交落到远端」，不保留本地那 6 个提交的分割历史
// （那些提交的信息已经写在本地 git log 里，远端拿到一份即可）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = process.argv[2] || 'ccai40359-wq/finalcheck';
const branch = process.argv[3] || 'main';
const messageArg = process.argv[4] || null;

const api = (args, input) => {
  const opts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  if (input) opts.input = input;
  return JSON.parse(execFileSync('gh', ['api', ...args], opts));
};
const git = (...a) => execFileSync('git', ['-c', 'core.quotepath=false', ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

// ① 远端当前 main
const remoteHead = api([`repos/${repo}/commits/${branch}`]);
const parentSha = remoteHead.sha;
const baseTree = remoteHead.commit.tree.sha;
console.log('remote head :', parentSha);
console.log('base tree   :', baseTree);

// ② 本地所有 tracked 文件（HEAD 里的，不是工作区）
// 一次 ls-tree 拿到「路径 → blob sha → mode」，避免对每个文件再调 rev-parse
// （中文/空格路径在 rev-parse HEAD:path 里容易出转义问题，被 Mimosa 也误报过）。
const lsTree = git('ls-tree', '-r', '--long', 'HEAD');
const localInfo = new Map();
for (const line of lsTree.split('\n')) {
  if (!line.trim()) continue;
  const tab = line.indexOf('\t');
  if (tab < 0) continue;
  const head = line.slice(0, tab).split(' ');
  const rel = line.slice(tab + 1);
  localInfo.set(rel, { mode: head[0], sha: head[2] });
}
const localFiles = [...localInfo.keys()];
console.log('local files :', localFiles.length);

// 远端 tree（递归）
const remoteTree = api([`repos/${repo}/git/trees/${baseTree}?recursive=1`]);
if (remoteTree.truncated) console.log('WARN: remote tree truncated, results may be partial');
const remotePaths = new Map();
for (const e of remoteTree.tree || []) {
  if (e.type === 'blob') remotePaths.set(e.path, e.sha);
}
console.log('remote files:', remotePaths.size);

// ③ 逐个比对 blob sha（git 的 sha 与 GitHub 的 sha 算法一致，可直接比）
const entries = [];
let uploaded = 0;
let deleted = 0;
for (const rel of localFiles) {
  const info = localInfo.get(rel);
  if (!info) continue;
  const remoteSha = remotePaths.get(rel);
  if (info.sha === remoteSha) continue; // 内容一致，跳过
  const mode = info.mode || '100644';
  // 上传内容
  const content = fs.readFileSync(path.resolve(rel));
  const tmp = path.join(os.tmpdir(), 'fc-blob-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(tmp, JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }), 'utf8');
  const res = api([`repos/${repo}/git/blobs`, '--method', 'POST', '--input', tmp]);
  fs.unlinkSync(tmp);
  entries.push({ path: rel, mode, type: 'blob', sha: res.sha });
  uploaded++;
  if (uploaded % 20 === 0) console.log(`  ...${uploaded} blobs uploaded`);
}
// 远端有、本地 HEAD 没有 → 删除
for (const [rel, sha] of remotePaths) {
  if (!localInfo.has(rel)) {
    entries.push({ path: rel, mode: '100644', type: 'blob', sha: null }); // sha:null = 删除
    deleted++;
  }
}
console.log(`changed: ${uploaded} modified/added, ${deleted} deleted`);

if (!entries.length) {
  console.log('远端已与本地一致，无需推送');
  process.exit(0);
}

// ④ 建 tree
const treeTmp = path.join(os.tmpdir(), 'fc-tree-' + Math.random().toString(36).slice(2) + '.json');
fs.writeFileSync(treeTmp, JSON.stringify({ base_tree: baseTree, tree: entries }), 'utf8');
const tree = api([`repos/${repo}/git/trees`, '--method', 'POST', '--input', treeTmp]);
fs.unlinkSync(treeTmp);
console.log('new tree    :', tree.sha);

// ⑤ 建 commit
const message = messageArg || [
  'feat: Python helpers, sandbox split, cross-project authorization, compaction steps 1-9',
  '',
  'Squashed snapshot of the local commits that were not yet pushed:',
  '  e93009f feat(python): structure parser + Q3 support',
  '  12c5dc1 feat(policy): disable ACL sandbox + allow cross-directory work',
  '  fa6af01 refactor(context): steps 1+2 (kill the 400k line, merge thresholds)',
  '  0f49bd7 feat(context): step 3 (tool results become index lines)',
  '  78e0cc4 feat(sandbox): split ACL switch out of policy.mode + restore three gates',
  '  ca50d46 feat(context): steps 4-9 (per-round memory, rollup, ledger, task pack)'
].join('\n');
const commitTmp = path.join(os.tmpdir(), 'fc-commit-' + Math.random().toString(36).slice(2) + '.json');
fs.writeFileSync(commitTmp, JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }), 'utf8');
const commit = api([`repos/${repo}/git/commits`, '--method', 'POST', '--input', commitTmp]);
fs.unlinkSync(commitTmp);
console.log('new commit  :', commit.sha);

// ⑥ 移动分支
api([`repos/${repo}/git/refs/heads/${branch}`, '--method', 'PATCH', '-f', `sha=${commit.sha}`]);
console.log(`\nOK ${branch} -> ${commit.sha}`);
console.log(`   https://github.com/${repo}/commit/${commit.sha}`);
