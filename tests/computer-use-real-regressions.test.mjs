// CU 真机测试踩到的问题（2026-11-21），全部固化成回归：
// 这三个都不是单测能想到的，只有真的在 Windows 上跑才暴露。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const inputSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/desktop-input-win.mjs'), 'utf8');
const cuSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/computer-use.mjs'), 'utf8');

test('cu-real: stdin 非 ASCII 必须转义成 \\uXXXX（否则中文变「娴嬭瘯」）', () => {
  // 真机现象：输入「FC测试输入」，页面上出现「1FC娴嬭瘯杈撳叆」
  // 根因：PowerShell 的 stdin 按系统 ANSI（中文 Windows = GBK）解码 UTF-8 中文
  // 按行找关键词，避免正则/转义歧义
  const lines = inputSrc.split('\n');
  const escapeLine = lines.find((l) => l.includes('JSON.stringify(cmd).replace('));
  assert.ok(escapeLine, '必须有对 cmd JSON 的转义处理');
  const codeLine = lines.find((l) => l.includes("'0000' + c.charCodeAt(0)"));
  assert.ok(codeLine, '必须把字符转成 \\uXXXX 形式（ASCII 安全）');
  const sendLine = lines.find((l) => l.includes('stdin.write'));
  assert.ok(sendLine && sendLine.includes('pending.json'), 'next() 必须发预转义的那个');
});

test('cu-real: PowerShell 输出编码必须设成 UTF-8（否则读窗口标题的中文会乱码）', () => {
  assert.match(inputSrc, /\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/);
});

test('cu-real: focus 抢前台必须用 AttachThreadInput（SetForegroundWindow 后台调用会静默失败）', () => {
  // 真机现象：靶子窗口 show()+focus() 之后前台仍然是别的应用，于是"点靶子"实际点到用户的应用上
  assert.match(inputSrc, /AttachThreadInput/);
  assert.match(inputSrc, /GetForegroundWindow/);
  // 必须回报真实结果，不是"我调过了"
  assert.match(inputSrc, /becameForeground|now\.ToInt64\(\) -eq \$h\.ToInt64\(\)/);
});

test('cu-real: GetCurrentThreadId 必须从 kernel32 导入（user32 里没有这个入口点）', () => {
  // 真机报错：无法在 DLL "user32.dll" 中找到名为 "GetCurrentThreadId" 的入口点
  const tidLine = inputSrc.split('\n').find((l) => l.includes('GetCurrentThreadId') && l.includes('DllImport'));
  assert.ok(tidLine, '必须有 GetCurrentThreadId 的 DllImport 声明');
  assert.ok(tidLine.includes('kernel32'), '它必须从 kernel32 导入，实际：' + (tidLine || '').trim());
});

test('cu-real: performAction 必须有前台目标校验（expectProcess）', () => {
  // 真机现象：靶子窗口没拿到前台时，"点靶子按钮"实际打到了用户正在玩的应用上，
  // 动作报 ok=true 但页面里点击计数是 0。这条防线是这次真机测出来才加的。
  assert.match(cuSrc, /expectProcess/);
  assert.match(cuSrc, /foreground-mismatch/);
  assert.match(cuSrc, /鼠标键盘输入只会送到当前前台窗口/);
});

test('cu-real: foregroundContext 必须先 ensureInputReady（否则首次调用报「进程未就绪」）', () => {
  // 真机现象：第一次调 foregroundContext 直接抛 Error: 输入注入进程未就绪
  const fnBody = cuSrc.slice(cuSrc.indexOf('export async function foregroundContext'));
  assert.match(fnBody.slice(0, 400), /ensureInputReady/, 'foregroundContext 里要先就绪');
});

test('cu-real: 截图必须返回 scale（模型按图上的像素点，要乘回去）', () => {
  const fnBody = cuSrc.slice(cuSrc.indexOf('export async function captureScreen'));
  assert.match(fnBody, /scale:/, 'captureScreen 必须算 scale');
});
