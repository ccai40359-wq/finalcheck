// Python 结构解析层单测（2026-11-17）。
// 这是 Q3/Q4/Q5/A2-A4 共用的地基，错了上层全错，所以单独锁。
// 要求：不依赖本机 Python、不读真实仓库（全部内联构造），保证 CI 与干净机器都能跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maskStrings, indentOf, isCommentOrBlank, parsePyStructure, importEdges
} from '../src/py-structure.mjs';

const SAMPLE = `
"""模块 docstring
   里面的括号和缩进不该影响解析 ( [ {
"""

import os
import logging
from .helpers import util
from services.email import send

CONST = 42

# 这是一条真注释（用于验证 commentLines 统计）
def top_level(a, b):
    if a:
        for i in range(3):
            while b:
                b -= 1
    return a + b


async def async_handler(request):
    data = await request.json()
    return {"ok": True}


class Repo:
    def method(self):
        return 1
`;

test('maskStrings: 三引号块内部的内容被屏蔽，块后的代码保留', () => {
  const code = maskStrings(SAMPLE.split('\n'));
  assert.equal(code.length, SAMPLE.split('\n').length, '行数不变（保持行号对应）');
  // docstring 里的那行含 `(` `[` `{`，必须被屏蔽（不留内容）
  const docIdx = SAMPLE.split('\n').findIndex((l) => l.includes('里面的括号'));
  assert.ok(docIdx >= 0, '样例里必须有这行');
  assert.equal(String(code[docIdx]).trim(), '', 'docstring 内的行应被清空');
  // docstring 之后的 import 必须保留
  assert.ok(code.some((l) => l.includes('import os')), 'docstring 后的代码不能被吞');
});

test('indentOf: 空格按 1、Tab 按 4', () => {
  assert.equal(indentOf('    x'), 4);
  assert.equal(indentOf('\tx'), 4);
  assert.equal(indentOf('  \t x'), 7);
  assert.equal(indentOf('x'), 0);
});

test('parsePyStructure: 函数/类/行数统计正确', () => {
  const s = parsePyStructure(SAMPLE);
  assert.equal(s.lines, SAMPLE.split('\n').length);
  const names = s.functions.map((f) => f.name);
  assert.ok(names.includes('top_level'), '顶层函数');
  assert.ok(names.includes('async_handler'), 'async 函数');
  assert.ok(names.includes('method'), '类方法也算函数');
  const asyncFn = s.functions.find((f) => f.name === 'async_handler');
  assert.equal(asyncFn.isAsync, true, 'async 必须识别');
  assert.equal(s.classes.length, 1, '一个类');
  assert.equal(s.classes[0].name, 'Repo');
});

test('parsePyStructure: 嵌套深度按块关键字算（if+for+while = 3 层）', () => {
  const s = parsePyStructure(SAMPLE);
  const fn = s.functions.find((f) => f.name === 'top_level');
  assert.equal(fn.maxDepth, 3, `if → for → while 三层，实际 ${fn.maxDepth}`);
});

test('parsePyStructure: 注释与空行分开统计', () => {
  const s = parsePyStructure(SAMPLE);
  assert.ok(s.commentLines >= 1, '有注释行');
  assert.ok(s.blankLines >= 3, '有空行');
  assert.ok(s.codeLines > 0);
  // docstring 占的行既不是代码、也不算注释/空行（它是有语义的内容，但被 mask 掉了）。
  // 所以三者和 ≤ 总行数，差额正好是 docstring 行数。
  assert.ok(s.codeLines + s.commentLines + s.blankLines <= s.lines,
    '三者之和不能超过总行数');
});

test('parsePyStructure: 函数体行数不含 def 行本身', () => {
  const s = parsePyStructure('def f():\n    a = 1\n    b = 2\n');
  const fn = s.functions[0];
  assert.equal(fn.bodyLines, 2, '函数体 2 行');
  assert.equal(fn.start, 1, 'start 是 1 基行号');
});

test('importEdges: 点号绝对导入能映射到仓库内文件', () => {
  const s = parsePyStructure('from services.email import send\n');
  const known = new Set(['services/email.py']);
  const r = importEdges(s, 'main.py', known);
  assert.deepEqual(r.edges.map((e) => e.target), ['services/email.py'],
    'from services.email import x 应映射到 services/email.py');
});

test('importEdges: 第三方/标准库不算边（否则会报假导入环）', () => {
  const s = parsePyStructure('import logging\nimport uuid\nfrom fastapi import FastAPI\nfrom sqlalchemy.orm import Session\n');
  const known = new Set(['app.py']);
  const r = importEdges(s, 'app.py', known);
  assert.equal(r.edges.length, 0, '仓库里没有 logging.py 等，不能算内部边');
});

test('importEdges: 相对导入按层级还原', () => {
  const s = parsePyStructure('from .helpers import util\nfrom ..pkg import x\n');
  const r = importEdges(s, 'a/b/c.py', new Set(['a/b/helpers.py', 'a/pkg.py']));
  const targets = r.edges.map((e) => e.target);
  assert.ok(targets.includes('a/b/helpers.py'), `一级相对导入还原错: ${targets}`);
  assert.ok(targets.includes('a/pkg.py'), `二级相对导入还原错: ${targets}`);
});

test('importEdges: 动态导入进 unsupported，不猜路径', () => {
  const s = parsePyStructure('import importlib\nimportlib.import_module(name)\n');
  const r = importEdges(s, 'x.py', new Set());
  assert.ok(r.unsupported.some((u) => /动态导入/.test(u.reason)),
    '动态导入必须报未覆盖，不能静默');
});

test('parsePyStructure: 语法怪异的文件不崩（宁可少解析也不抛）', () => {
  const weird = 'def f(\n  未闭合的括号\n""" 未闭合的三引号\n';
  assert.doesNotThrow(() => parsePyStructure(weird), '脏输入不能让整轮审计崩掉');
});

test('parsePyStructure: 空文件安全', () => {
  const s = parsePyStructure('');
  assert.equal(s.lines, 1);
  assert.equal(s.functions.length, 0);
  assert.equal(s.imports.length, 0);
});
