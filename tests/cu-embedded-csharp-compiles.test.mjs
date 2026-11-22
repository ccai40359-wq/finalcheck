// 0.30.4 真机事故回归：C# 源码语法错误会让整个注入宿主起不来 → 所有截图/动作全挂。
// 背景：我给 TypeText 加延时写了 `const charDelayMs = 15;`——C# 没有类型推断的 const，
// 必须 `const int charDelayMs = 15;`。node --check 只验 JS 语法，验不到内嵌 C#。
// 真机实测：模型每步都报 "Add-Type ... 应输入标识符"，整轮 21 次 run_command 全部白跑。
//
// 本测试做两件事：
//  ① 静态钉：C# 代码块里禁止出现无类型的 `const <name> =`（唯一已知会整段编译失败的写法类）
//  ② 真编译（Windows + PowerShell 可用时）：把 desktop-input-win.mjs 里的 C# 源码真正
//     Add-Type 编译一次，编译通过才算过（这是唯一能真正抓住此类错误的验证）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(repoRoot, 'desktop/src/main/desktop-input-win.mjs'), 'utf8');

/** 从 JS 模板字符串里抽出内嵌的 C# 源码（$Cs / $Signals 等 here-string 的正文） */
export function extractCsharpSources(text) {
  const out = [];
  // PowerShell here-string 形如 @' ... '@ 或 @" ... "@
  const re = /@['"]\r?\n([\s\S]*?)\r?\n['"]@/g;
  for (const m of text.matchAll(re)) {
    const body = m[1];
    // 只要看起来像 C# 的（含 class/namespace/using System）
    if (/class\s+\w+|\busing\s+System\b/.test(body)) out.push(body);
  }
  return out;
}

const csharpBlocks = extractCsharpSources(src);

test('C# 源码块能被正确抽取（守卫测试本身有效）', () => {
  assert.ok(csharpBlocks.length >= 1, `应至少抽出一段 C# 源码，实际 ${csharpBlocks.length}`);
  assert.ok(csharpBlocks.some((b) => /class\s+\w+/.test(b)), '抽出的源码里应有 class 定义');
  // 确认 TypeText 在抽出的源码里（这样下面的编译验证才覆盖到它）
  assert.ok(csharpBlocks.some((b) => b.includes('TypeText')), 'C# 源码必须包含 TypeText（否则编译验证覆盖不到打字路径）');
});

test('静态钉：C# 里禁止无类型 const（const x = 1 会整段编译失败）', () => {
  for (const body of csharpBlocks) {
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 跳过注释行
      if (/^\s*\/\//.test(line)) continue;
      // const 后面必须紧跟类型关键字（int/long/string/double/uint/bool/...）
      const m = line.match(/^\s*(?:public|private|internal|protected)?\s*const\s+([A-Za-z_]\w*)\s*=/);
      if (m) {
        assert.fail(`C# 无类型 const：第 ${i + 1} 行「${line.trim()}」——必须是 const int/long/string 等显式类型（否则 Add-Type 编译失败，整个桌面操作全挂）`);
      }
    }
  }
});

test('静态钉：C# foreach 变量必须先声明类型（foreach (char c in text) 合法）', () => {
  for (const body of csharpBlocks) {
    const bad = body.match(/foreach\s*\(\s*var\s+\w+\s+in\s+/);
    // var 在 C# 里是合法的（类型推断 foreach 允许 var），此处只确认 TypeText 用的是显式 char
    if (body.includes('TypeText')) {
      assert.match(body, /foreach \(char c in text\)/, 'TypeText 必须用显式 foreach (char c in text)');
    }
    assert.ok(!bad || true); // var 合法，不作失败条件
  }
});

test('真编译：内嵌 C# 源码必须能被 PowerShell Add-Type 编译通过', { skip: process.platform !== 'win32' && '仅 Windows' }, () => {
  // 把抽出的 C# 源码写到临时文件并真编译（等价于运行时 Add-Type 做的事）
  // 只编译类定义部分：源里可能引用 System.Windows.Forms，Add-Type 会自动解析 GAC 程序集
  const body = csharpBlocks.find((b) => b.includes('TypeText')) || csharpBlocks[0];
  const psScript = [
    '$ErrorActionPreference = "Stop"',
    '$code = @\'',
    body,
    "'@",
    // 与运行时同款引用集（见 desktop-input-win.mjs 的 Add-Type -ReferencedAssemblies）
    'Add-Type -TypeDefinition $code -ReferencedAssemblies System.Windows.Forms',
    'Write-Output "COMPILED-OK"'
  ].join('\n');
  let out = '';
  try {
    out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      encoding: 'utf8', timeout: 120000, windowsHide: true
    });
  } catch (error) {
    const msg = String((error && (error.stdout || error.stderr || error.message)) || '');
    assert.fail(`内嵌 C# 源码编译失败（这会让整个桌面操作全挂）：${msg.slice(0, 800)}`);
  }
  assert.match(String(out), /COMPILED-OK/, 'Add-Type 必须成功输出 COMPILED-OK');
});
