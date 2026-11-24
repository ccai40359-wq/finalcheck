// 0.33.1 @文件引用：解析 / 展开（项目内、上限、二进制、目录）/ 候选打分 + 全链路（模型真的看到文件内容，会话里不存展开结果）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { findMentions, expandMentions, appendMentionBlocks, scorePath, fileSuggestions } from '../desktop/src/main/mentions.mjs';
import { startGateway } from '../scripts/sim/gateway.mjs';
import { createSimClient } from '../scripts/sim/client.mjs';

test('findMentions：@路径 / @"带空格" / 去尾标点 / 去重；邮箱不算', () => {
  assert.deepEqual(findMentions('看 @src/a.js 和 @"docs/my file.md"，再看 @src/a.js。'), ['src/a.js', 'docs/my file.md']);
  assert.deepEqual(findMentions('@README.md, 谢谢'), ['README.md']);
  assert.deepEqual(findMentions('mail me@x.com'), []);
});

test('expandMentions：带行号附文件、目录给清单、越界 / 二进制 / 不存在分别处理', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fc-mention-'));
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'a.js'), 'const a = 1;\nexport default a;\n');
    writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
    const ex = await expandMentions('改 @src/a.js 参考 @src 别看 @../secret.txt @bin.dat @someone', { root });
    assert.deepEqual(ex.attached, ['src/a.js', 'src/']);
    assert.match(ex.blocks[0], /<file path="src\/a\.js">\n1\tconst a = 1;\n2\texport default a;/);
    assert.match(ex.blocks[1], /<directory path="src">\na\.js\n<\/directory>/);
    assert.deepEqual(ex.skipped.map((s) => s.path), ['../secret.txt', 'bin.dat']);
    const s = appendMentionBlocks('hi', ex);
    assert.ok(s.startsWith('hi') && s.includes('不在项目目录里'));
    const arr = appendMentionBlocks([{ type: 'text', text: 'hi' }], ex);
    assert.equal(arr.length, 2);
    assert.equal(appendMentionBlocks('x', { blocks: [], skipped: [] }), 'x');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('候选：文件名精确 > 前缀 > 包含 > 路径 > 子序列；目录也给', async () => {
  assert.ok(scorePath('src/app.jsx', 'app.jsx') > scorePath('src/application.jsx', 'app'));
  assert.ok(scorePath('src/app.jsx', 'app') > scorePath('lib/myapp.js', 'app'));
  assert.equal(scorePath('src/app.jsx', 'zzz'), -1);
  assert.ok(scorePath('desktop/src/main/backend.mjs', 'dsmb') > 0);
  const root = mkdtempSync(path.join(os.tmpdir(), 'fc-mention-s-'));
  try {
    mkdirSync(path.join(root, 'src', 'main'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'main', 'backend.mjs'), 'x');
    writeFileSync(path.join(root, 'README.md'), 'x');
    const r = await fileSuggestions(root, 'back');
    assert.equal(r[0], 'src/main/backend.mjs');
    assert.ok((await fileSuggestions(root, 'mai')).includes('src/main/'));
    assert.equal((await fileSuggestions(root, '')).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('全链路：@文件内容进了发给模型的那条消息，但会话记录里仍是原文；候选 IPC 按会话项目给', async () => {
  const seen = [];
  const gw = await startGateway({
    mode: 'script',
    respond: (body, { kind }) => {
      if (kind !== 'main') return null;
      seen.push(body.messages);
      return { content: '看到了。' };
    }
  });
  const sim = await createSimClient({
    label: 'mentions', gateway: gw, config: { permissionMode: 'full' },
    project: { files: { 'notes/plan.md': '# 计划\n第一步：MENTION_MARKER_42\n' } }
  });
  try {
    const sid = await sim.newSession();
    const cands = await sim.invoke('finalcheck:project-files', sid, 'plan');
    assert.equal(cands[0], 'notes/plan.md');
    await sim.send(sid, '按 @notes/plan.md 做');
    const lastUser = seen.at(-1).filter((m) => m.role === 'user').at(-1);
    const text = typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content);
    assert.match(text, /<file path="notes\/plan\.md">[\s\S]*MENTION_MARKER_42/);
    // 下一轮：上一条用户消息回到原文（展开只发生在当轮副本里，不污染历史 / 不重复占上下文）
    await sim.send(sid, '好的，继续');
    const users = seen.at(-1).filter((m) => m.role === 'user');
    assert.ok(users.length >= 2);
    const prev = users.at(-2);
    const prevText = typeof prev.content === 'string' ? prev.content : JSON.stringify(prev.content);
    assert.match(prevText, /按 @notes\/plan\.md 做/);
    assert.ok(!prevText.includes('MENTION_MARKER_42'), '展开内容不进历史');
  } finally {
    await sim.backend()?.shutdown?.();
    await sim.close();
    await gw.close?.();
  }
});
