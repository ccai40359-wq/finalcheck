// 0.30.2：会话底部横向滚动条 + 自检止损线（两个用户实测反馈的修复）
// 1) 宽表格把消息区撑宽 → 底部出现横向滚动条（只有含表格的会话中招）
// 2) 视觉自检无止损 → 34 次截图反复挑像素级细节
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(repoRoot, 'desktop/src/renderer/styles.css'), 'utf8');
const messageList = readFileSync(path.join(repoRoot, 'desktop/src/renderer/components/MessageList.jsx'), 'utf8');
const agentService = readFileSync(path.join(repoRoot, 'desktop/src/main/agent-service.mjs'), 'utf8');

test('横向滚动条：消息容器禁止横向溢出（底部横条的根因）', () => {
  assert.match(messageList, /data-testid="message-scroll"[^>]*overflow-y-auto overflow-x-hidden/,
    '消息滚动容器必须同时设 overflow-x-hidden，否则宽内容会把整个消息区撑宽');
});

test('横向滚动条：表格自身可横滑但不得撑宽父容器', () => {
  const tableBlock = css.slice(css.indexOf('.md table {'), css.indexOf('.md th, .md td {'));
  assert.match(tableBlock, /overflow-x: auto;/, '表格保留内部横滑（宽表格内容仍可看全）');
  assert.match(tableBlock, /max-width: 100%;/, '表格必须有 max-width:100%，否则 display:block 会撑宽父容器');
  assert.match(tableBlock, /box-sizing: border-box;/, 'box-sizing 保证 padding/border 不额外加宽');
});

test('自检止损：指引写明最多 3 轮 + 只修严重问题（像素级微调不复查）', () => {
  // capture_screenshot 的工具描述（模型第一手看到的）
  assert.match(agentService, /同一产物的自检最多 3 轮/, '工具描述必须写明自检轮次上限');
  assert.match(agentService, /像素级微调不要反复截图复查/, '工具描述必须排除像素级微调');
  // 两处系统提示的看图指导
  const guideCount = (agentService.match(/自检有止损线/g) || []).length;
  assert.ok(guideCount >= 2, `两处轨（audit/dev）的看图指导都要带止损线，实际 ${guideCount} 处`);
  assert.match(agentService, /同一产物最多 3 轮自检/, '系统提示必须写明轮次上限');
  assert.match(agentService, /严重问题（内容截断、元素重叠、白屏、错位）/, '必须界定什么算严重问题');
});

test('自检止损不能把「必须截图」这条底线删掉（防过度修正）', () => {
  assert.match(agentService, /写完 HTML\/CSS\/JS 一定要先截图看一遍再交/, '「先看一眼再交」的底线必须保留');
  assert.match(agentService, /不要只看代码就说「应该没问题」/, '禁止仅凭代码判断的纪律必须保留');
});
