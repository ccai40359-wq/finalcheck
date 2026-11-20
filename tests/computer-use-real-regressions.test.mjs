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

test('cu-real: guarded focus uses Windows policy and reports actual foreground', () => {
  const guardedFocus = inputSrc.slice(inputSrc.indexOf('public static bool GuardedFocus'), inputSrc.indexOf('public static string CursorPos'));
  assert.match(guardedFocus, /GetWindowThreadProcessId\(target, out pid\)/);
  assert.match(guardedFocus, /return GetForegroundWindow\(\) == target/);
  assert.doesNotMatch(guardedFocus, /AttachThreadInput/);
  assert.match(cuSrc, /!result\.ok \|\| !result\.becameForeground/);
});

test('cu-real: GetCurrentThreadId 必须从 kernel32 导入（user32 里没有这个入口点）', () => {
  // 真机报错：无法在 DLL "user32.dll" 中找到名为 "GetCurrentThreadId" 的入口点
  const tidLine = inputSrc.split('\n').find((l) => l.includes('GetCurrentThreadId') && l.includes('DllImport'));
  assert.ok(tidLine, '必须有 GetCurrentThreadId 的 DllImport 声明');
  assert.ok(tidLine.includes('kernel32'), '它必须从 kernel32 导入，实际：' + (tidLine || '').trim());
});

test('cu-real: action binds screenshot identity and performs foreground checks again in the native helper', () => {
  assert.match(cuSrc, /shot\.screenshotId !== params\.screenshotId/);
  assert.match(cuSrc, /sameObservation\(shot\.foreground, foreground\)/);
  assert.match(inputSrc, /foreground\.ToInt64\(\) != guard\.hwnd \|\| pid != guard\.pid/);
  assert.match(inputSrc, /GetAncestor\(window, GA_ROOT\)\.ToInt64\(\) != guard\.hwnd/);
  assert.match(inputSrc, /inserted != events\.Length/);
});

test('cu-real: desktopContext waits for the helper before querying desktop state', () => {
  const fnBody = cuSrc.slice(cuSrc.indexOf('async function desktopContext'), cuSrc.indexOf('export async function foregroundContext'));
  assert.match(fnBody, /await input\.ensureInputReady\(\);\s+const state = await input\.desktopState\(\)/);
});

test('cu-real: capture keeps legacy scale metadata without accepting it from actions', () => {
  const fnBody = cuSrc.slice(cuSrc.indexOf('async function capture('));
  assert.match(fnBody, /scale:/);
  assert.doesNotMatch(cuSrc, /params\.scale/);
});

test('cu-real: guarded key validates one chord and checks foreground and child focus before each dispatch', () => {
  const key = inputSrc.slice(inputSrc.indexOf('public static void Key'), inputSrc.indexOf('public static void TypeText'));
  const guarded = key.slice(key.indexOf('if (repeat < 1'));
  assert.match(guarded, /repeat > 100/);
  assert.match(guarded, /GuardedKeyEvents\(keyName\)/);
  assert.match(guarded, /AssertForeground\(guard, true, true\);\s+Submit\(events, events\.Length \/ 2\)/);
  assert.doesNotMatch(guarded, /SendKeys/);
  assert.match(cuSrc, /before\?\.foreground\?\.focusHwnd === foreground\?\.focusHwnd/);
  assert.match(cuSrc, /if \(!keyboard\) latestScreenshot = null;/);
});

test('cu-real: native point checks include an existing mouse-capture owner', () => {
  const point = inputSrc.slice(inputSrc.indexOf('static void AssertPoint'), inputSrc.indexOf('static POINT ReadCursor'));
  assert.match(point, /info\.capture != IntPtr\.Zero && GetAncestor\(info\.capture, GA_ROOT\)\.ToInt64\(\) != guard\.hwnd/);
});
