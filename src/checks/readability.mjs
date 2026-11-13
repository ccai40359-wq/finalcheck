import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parse } from '@babel/parser';
import { t } from '../../desktop/src/renderer/i18n/core.mjs';
import { findBinary } from '../which.mjs';
import { listTextFiles, prunedWarning, fixturesWarning } from '../walk.mjs';
import {
  DEFAULT_NOISE_HINTS, noiseWarning, reportCap, truncationRecord, truncationWarning,
} from '../report-caps.mjs';

// Q4 可读性检查（纯静态启发式，不执行被审代码、不联网、不装依赖）。
//
// 输出与其它检查层一致：{ checkId, findings, coverageGap, warnings }。
// 每条 finding 都带 file + 1 基行号 + ≤120 字代码片段（已脱敏），便于人工复核；
// 启发式结论一律 force/level = 'check'，不自动拦截档位结论。
//
// 规则：
//   1. 函数过长      > 60 行 提醒；> 120 行 中危
//   2. 嵌套过深      函数内控制流 > 4 层
//   3. 注释密度过低  ≥200 行且注释行 < 3%（排除生成代码 / 头部 eslint-disable / minified）
//   4. 魔法数        同一函数内 ≥3 个字面量数字（排除 0/1/-1/2/100/1000 与计时/尺寸上下文）
//   5. 命名          单字母/无信息词/单字符函数名（排除循环变量、解构占位、_ 前缀、真正有初始值线索的局部临时量）
//   6. 重复表达      同文件内 ≥3 处相同字符串字面量（≥12 字符）
//   7. any/@ts-ignore ts/tsx 里的 any / as any / @ts-ignore
//
// 阈值全部可由 opts.thresholds 覆盖；默认值见 DEFAULT_THRESHOLDS。
const CHECK_ID = 'Q4';

const TS_EXT_RE = /\.(?:ts|tsx)$/i;
// 文件收集统一走 walk.mjs（与 Q3/Q5 同一份构建产物/夹具/exclude 口径）
const WALK_DEPTH_LIMIT = 12;
const MAX_SNIPPET = 120;

const DEFAULT_THRESHOLDS = Object.freeze({
  maxFiles: 500,               // 文件数上限（超限写 warning，不静默）
  maxFileBytes: 1024 * 1024,   // 单文件上限 1MB
  maxFunctionLines: 60,        // 提醒阈值
  hardFunctionLines: 120,      // 中危阈值
  maxNesting: 4,               // 控制流嵌套层数
  commentMinFileLines: 200,    // 注释密度只在 ≥200 行文件上判
  commentMinRatio: 0.03,       // 注释行占比下限 3%
  magicNumberCount: 3,         // 同一函数内非豁免数字个数
  duplicateStringMinLength: 12,
  duplicateStringCount: 3,
  // 单文件单规则上限：默认 Infinity（不截断）。命令行/reportCaps["Q4.perFile"] 是正式开关；
  // 这里保留旧阈值键作为兼容回落，显式传正整数时才按旧行为截断。
  maxFindingsPerRule: Infinity,
  // 跨文件全局限额：默认不截断（Infinity）。显式配置 reportCaps["Q4.perRule"] 时才按规则取前 N 条，
  // 截断会同时写 warning 与 reportTruncations（报告 ## Not covered 点名）。只影响「报几条」，不改规则阈值。
  maxFindingsPerRuleGlobal: Infinity,
});

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
  'TSDeclareFunction',
]);

const CONTROL_FLOW_TYPES = new Set([
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'SwitchStatement',
  'TryStatement',
  'WithStatement',
]);

// 这些名字出现数字时通常是尺寸/计时，不算魔法数
const SIZE_TIME_NAMES = /^(?:width|height|top|left|right|bottom|size|fontSize|lineHeight|padding|margin|gap|radius|opacity|delay|duration|timeout|interval|ms|px|spacing|zIndex|scale|ratio|percent)$/i;
const TIMING_FN_NAMES = new Set([
  'setTimeout', 'setInterval', 'setImmediate', 'requestAnimationFrame',
  'sleep', 'wait', 'delay', 'timeout', 'throttle', 'debounce',
]);

// 允许的单字母名：循环变量 / 坐标 / 占位
const NAMING_ALLOWED = new Set(['i', 'j', 'k', 'x', 'y', 'z']);
// 明确无信息量的变量名：这些名字放到任何上下文里都看不出用途
const NAMING_NOISE = new Set(['data', 'temp', 'tmp', 'foo', 'bar', 'obj', 'val', 'arr', 'str', 'num']);
// 初始值本身说明不了含义的形态：没有初始值，或只是一个字面量/简单容器/直接引用
const NAMING_OPAQUE_INIT_TYPES = new Set([
  'NumericLiteral', 'StringLiteral', 'BooleanLiteral', 'NullLiteral', 'BigIntLiteral',
  'RegExpLiteral', 'ObjectExpression', 'ArrayExpression', 'Identifier', 'TemplateLiteral',
]);

const SKIP_KEYS = new Set([
  'loc', 'start', 'end', 'range', 'extra', 'leadingComments', 'trailingComments',
  'innerComments', 'comments', 'tokens', 'errors',
]);

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const SECRET_ASSIGN_RE = /([A-Za-z0-9_.-]*(?:key|secret|token|password|passwd|pwd)[A-Za-z0-9_.-]*)\s*[:=]\s*["']?([^\s"',;)]{6,})/gi;
const SECRET_TOKEN_RE = /(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
const LONG_TOKEN_RE = /\b[A-Za-z0-9+/=_-]{32,}\b/g;

// ---------------------------------------------------------------- 工具函数

// 证据脱敏：控制字符/ANSI/密钥形态一律打码，再截到 120 字
function safeText(value) {
  let out = String(value == null ? '' : value);
  out = out.replace(ANSI_RE, '').replace(CONTROL_RE, '');
  out = out.replace(SECRET_ASSIGN_RE, (_m, name) => `${name}=***`);
  out = out.replace(SECRET_TOKEN_RE, '***').replace(LONG_TOKEN_RE, '***');
  out = out.replace(/\s+/g, ' ').trim();
  return out.slice(0, MAX_SNIPPET);
}

function snippetAt(lines, line) {
  const text = lines[Number(line) > 0 ? Number(line) - 1 : 0] || '';
  return safeText(text);
}

function normalizeThresholds(raw, warnings) {
  const out = { ...DEFAULT_THRESHOLDS };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = Number(raw[key]);
    // Infinity 是默认值的合法形态（不截断）；JSON 写不出来，但代码调用可以直接传
    if (value === Infinity) {
      out[key] = Infinity;
      continue;
    }
    if (!Number.isFinite(value) || value <= 0) {
      warnings.push(t('Q4：阈值 {key} 无效（{value}），使用默认 {def}', { key, value: String(raw[key]), def: DEFAULT_THRESHOLDS[key] }));
      continue;
    }
    out[key] = key === 'commentMinRatio' ? Math.min(1, value) : Math.floor(value);
  }
  return out;
}

function forEachChild(node, cb) {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item.type === 'string') cb(item, node, key);
      }
    } else if (value && typeof value.type === 'string') {
      cb(value, node, key);
    }
  }
}

function calleeName(callee) {
  if (!callee) return '';
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed) {
    if (callee.property && callee.property.type === 'Identifier') return callee.property.name;
    if (callee.property && callee.property.type === 'StringLiteral') return callee.property.value;
  }
  return '';
}

function memberName(node) {
  if (!node || node.type !== 'MemberExpression') return '';
  if (!node.computed && node.property && node.property.type === 'Identifier') return node.property.name;
  if (node.property && node.property.type === 'StringLiteral') return node.property.value;
  return '';
}

function functionName(entry) {
  const { node, parent } = entry;
  if (node.id && node.id.type === 'Identifier' && node.id.name) return node.id.name;
  if (node.key) {
    if (node.key.type === 'Identifier' && node.key.name) return node.key.name;
    if (node.key.type === 'StringLiteral' && node.key.value) return node.key.value;
  }
  if (!parent) return t('匿名函数');
  if (parent.type === 'VariableDeclarator' && parent.id && parent.id.type === 'Identifier') return parent.id.name;
  if (parent.type === 'AssignmentExpression' && parent.left && parent.left.type === 'Identifier') return parent.left.name;
  if (parent.type === 'ObjectProperty' && parent.key && parent.key.type === 'Identifier') return parent.key.name;
  return t('匿名函数');
}

function isModuleSpecifier(parent, key) {
  if (!parent) return false;
  if (key === 'source' && (
    parent.type === 'ImportDeclaration'
    || parent.type === 'ExportNamedDeclaration'
    || parent.type === 'ExportAllDeclaration'
    || parent.type === 'ImportExpression'
    || parent.type === 'TSExternalModuleReference'
  )) return true;
  if (parent.type === 'CallExpression' && key === 'arguments') {
    const name = calleeName(parent.callee);
    if (name === 'require' || name === 'import') return true;
  }
  return false;
}

function isNamedConstantOrSized(id) {
  if (!id || id.type !== 'Identifier') return false;
  const name = id.name;
  if (SIZE_TIME_NAMES.test(name)) return true;
  return /^[A-Z][A-Z0-9_]*$/.test(name) && name.length > 1;
}

// 数字是否属于「豁免上下文」：0/1/-1/2/100/1000、属性键、数组下标、计时/尺寸、全大写常量
function isExemptNumber(node, parent, key, grandparent) {
  const value = node.value;
  if (value === 0 || value === 1 || value === -1 || value === 2 || value === 100 || value === 1000) return true;
  // -1 的语法形态是 UnaryExpression(-, 1)
  if (parent && parent.type === 'UnaryExpression' && parent.operator === '-' && key === 'argument' && value === 1) return true;
  if (!parent) return false;

  // 对象/类成员键、枚举值、字面量类型
  if ((parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod'
    || parent.type === 'ClassProperty' || parent.type === 'ClassPrivateProperty'
    || parent.type === 'ClassMethod' || parent.type === 'ObjectMethod')
    && key === 'key') return true;
  if (parent.type === 'TSEnumMember' || parent.type === 'TSLiteralType') return true;

  // 数组下标 arr[3]
  if (parent.type === 'MemberExpression' && key === 'property' && parent.computed) return true;

  // 尺寸/计时上下文：对象属性 { width: 640 }
  if (parent.type === 'ObjectProperty' && key === 'value') {
    const name = parent.key && parent.key.type === 'Identifier' ? parent.key.name : '';
    if (name && SIZE_TIME_NAMES.test(name)) return true;
  }
  // JSX 属性 <Comp width={640} />
  if (grandparent && grandparent.type === 'JSXAttribute' && grandparent.name && grandparent.name.type === 'JSXIdentifier') {
    if (SIZE_TIME_NAMES.test(grandparent.name.name)) return true;
  }
  // 赋值 el.style.width = 640
  if (parent.type === 'AssignmentExpression' && key === 'right') {
    const name = memberName(parent.left);
    if (name && SIZE_TIME_NAMES.test(name)) return true;
  }
  // setTimeout(fn, 3000) / utils.sleep(1000)
  if (parent.type === 'CallExpression' && key === 'arguments') {
    if (TIMING_FN_NAMES.has(calleeName(parent.callee))) return true;
  }
  // const MAX_RETRIES = 3 / const timeoutMs = 3000
  if (parent.type === 'VariableDeclarator' && key === 'init' && isNamedConstantOrSized(parent.id)) return true;

  return false;
}

function detectHeader(lines) {
  const nonEmpty = [];
  for (const line of lines) {
    if (line.trim()) nonEmpty.push(line);
    if (nonEmpty.length >= 6) break;
  }
  return {
    generated: /@generated|code generated|do not edit|auto-?generated|automatically generated|generated by/i.test(nonEmpty.join('\n')),
    eslintDisabled: nonEmpty.some((line) => /^\s*(?:\/\/|\/\*)\s*eslint-disable(?!\s*-)/.test(line)),
  };
}

function detectMinified(lines) {
  const nonEmpty = lines.filter((line) => line.trim());
  if (!nonEmpty.length) return false;
  let total = 0;
  let maxLen = 0;
  for (const line of nonEmpty) {
    total += line.length;
    if (line.length > maxLen) maxLen = line.length;
  }
  const avg = total / nonEmpty.length;
  return avg > 500 || (nonEmpty.length <= 5 && maxLen > 1000) || (nonEmpty.length < 20 && maxLen > 2000);
}

// 只统计「整行是注释」的行；行尾注释算代码行（保守，避免把有代码的行算成注释）
function countCommentLines(lines) {
  let inBlock = false;
  let count = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      count++;
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (!line) continue;
    if (line.startsWith('//') || line.startsWith('#!')) { count++; continue; }
    const start = line.indexOf('/*');
    if (start === 0) {
      count++;
      if (line.indexOf('*/', 2) === -1) inBlock = true;
    }
  }
  return count;
}

// ---------------------------------------------------------------- 文件收集

// ---------------------------------------------------------------- 单文件分析

function makeEmitter(findings, warnings, file, thresholds, perFile) {
  const counts = new Map();
  return function emit(rule, severity, line, message, snippet) {
    const seen = counts.get(rule) || 0;
    counts.set(rule, seen + 1);
    // reportCaps["Q4.perFile"]：按文件+规则截断，总量在扫描结束后统一记账（warning/Not covered 要写准确数字）
    if (perFile) {
      const key = `${file}\u0000${rule}`;
      perFile.totals.set(key, (perFile.totals.get(key) || 0) + 1);
      if (seen >= perFile.cap) return;
    } else if (seen >= thresholds.maxFindingsPerRule) {
      // 兼容旧阈值键：显式传 thresholds.maxFindingsPerRule 时才走这条老路
      if (seen === thresholds.maxFindingsPerRule) {
        warnings.push(t('Q4：{file} 的 {rule} 命中过多，仅报告前 {max} 条', {
          file, rule, max: thresholds.maxFindingsPerRule,
        }));
      }
      return;
    }
    const evidence = { file, line, snippet };
    findings.push({
      checkId: CHECK_ID,
      severity,
      force: 'check', // 启发式只报不卡：人工复核前不锁死结论
      level: 'check',
      file,
      line,
      rule,
      snippet,
      message,
      evidence,
      source: 'program',
    });
  };
}

function pluginsFor(ext) {
  if (ext === '.ts') return ['typescript', 'decorators'];
  if (ext === '.tsx') return ['typescript', 'jsx', 'decorators'];
  return ['jsx'];
}

function analyzeFile({ file, ext, text, thresholds, emit, warnings }) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const header = detectHeader(lines);
  const minified = detectMinified(lines);
  if (header.generated || minified) return { skippedGenerated: true };

  let ast;
  try {
    ast = parse(text, {
      sourceType: 'unambiguous',
      plugins: pluginsFor(ext),
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowUndeclaredExports: true,
    });
  } catch (error) {
    warnings.push(t('Q4：{file} 解析失败，已跳过（{reason}）', {
      file,
      reason: safeText(error && error.message ? error.message : error),
    }));
    return { skippedGenerated: false };
  }

  const functions = [];
  const strings = new Map();
  const anyNodes = [];

  // 规则 3 注释密度（生成代码 / 头部 eslint-disable / minified 已在上面排除）
  if (!header.eslintDisabled && lines.length >= thresholds.commentMinFileLines) {
    const commentLines = countCommentLines(lines);
    const ratio = commentLines / lines.length;
    if (ratio < thresholds.commentMinRatio) {
      emit('Q4.comment-density', 'low', 1,
        t('注释密度过低：{total} 行文件仅 {comments} 行注释（{pct}% < {min}%），建议补关键决策说明', {
          total: lines.length,
          comments: commentLines,
          pct: (ratio * 100).toFixed(1),
          min: (thresholds.commentMinRatio * 100).toFixed(1),
        }),
        snippetAt(lines, 1));
    }
  }

  const stack = [{ node: ast.program, parent: null, key: null }];
  while (stack.length) {
    const item = stack.pop();
    const { node, parent, key } = item;
    if (FUNCTION_TYPES.has(node.type) && node.body) functions.push({ node, parent, key });
    if (node.type === 'StringLiteral' && typeof node.value === 'string') {
      if (node.value.length >= thresholds.duplicateStringMinLength && !isModuleSpecifier(parent, key)) {
        const line = node.loc ? node.loc.start.line : 0;
        const list = strings.get(node.value);
        if (list) list.push(line);
        else strings.set(node.value, [line]);
      }
    }
    if (TS_EXT_RE.test(ext) && node.type === 'TSAnyKeyword') {
      anyNodes.push({ node, parent, key });
    }
    forEachChild(node, (child, childParent, childKey) => {
      stack.push({ node: child, parent: childParent, key: childKey });
    });
  }

  // 规则 1 函数过长 + 规则 2 嵌套过深 + 规则 4 魔法数
  for (const entry of functions) {
    const { node } = entry;
    const startLine = node.loc ? node.loc.start.line : 0;
    const endLine = node.loc ? node.loc.end.line : startLine;
    const length = endLine - startLine + 1;
    const name = functionName(entry);

    if (length > thresholds.hardFunctionLines) {
      emit('Q4.fn-length', 'medium', startLine,
        t('函数 {name} 过长：{n} 行（中危阈值 {hard}），失控风险高，建议拆分', { name, n: length, hard: thresholds.hardFunctionLines }),
        snippetAt(lines, startLine));
    } else if (length > thresholds.maxFunctionLines) {
      emit('Q4.fn-length', 'low', startLine,
        t('函数 {name} 过长：{n} 行（提醒阈值 {max}），建议按职责拆分', { name, n: length, max: thresholds.maxFunctionLines }),
        snippetAt(lines, startLine));
    }

    const body = node.body;
    if (!body) continue;
    let maxDepth = 0;
    let deepestLine = startLine;
    const numbers = [];
    const bodyStack = [{ node: body, parent: node, key: 'body', depth: 0, grandparent: node }];
    while (bodyStack.length) {
      const cur = bodyStack.pop();
      const current = cur.node;
      // 嵌套函数单独分析，不把它的深度/数字算到外层
      if (current !== body && FUNCTION_TYPES.has(current.type)) continue;

      let depth = cur.depth;
      if (CONTROL_FLOW_TYPES.has(current.type)) {
        const elseIf = current.type === 'IfStatement'
          && cur.parent && cur.parent.type === 'IfStatement'
          && cur.key === 'alternate';
        depth += elseIf ? 0 : 1; // else-if 链不算新一层
        if (depth > maxDepth) {
          maxDepth = depth;
          deepestLine = current.loc ? current.loc.start.line : deepestLine;
        }
      }

      if (current.type === 'NumericLiteral' && !isExemptNumber(current, cur.parent, cur.key, cur.grandparent)) {
        numbers.push({
          value: current.value,
          line: current.loc ? current.loc.start.line : 0,
          column: current.loc ? current.loc.start.column : 0,
        });
      }

      forEachChild(current, (child, childParent, childKey) => {
        bodyStack.push({ node: child, parent: childParent, key: childKey, depth, grandparent: current });
      });
    }

    if (maxDepth > thresholds.maxNesting) {
      emit('Q4.nesting-depth', 'low', deepestLine,
        t('控制流嵌套 {depth} 层（上限 {max}），建议用早返回/提取函数压平', { depth: maxDepth, max: thresholds.maxNesting }),
        snippetAt(lines, deepestLine));
    }

    if (numbers.length >= thresholds.magicNumberCount) {
      numbers.sort((a, b) => (a.line - b.line) || (a.column - b.column));
      const unique = [...new Set(numbers.map((n) => n.value))].slice(0, 6);
      emit('Q4.magic-number', 'low', numbers[0].line,
        t('函数 {name} 内有 {n} 个字面量数字（{values} …），建议提成有名字的常量', {
          name, n: numbers.length, values: unique.join('、'),
        }),
        snippetAt(lines, numbers[0].line));
    }
  }

  // 规则 5 命名：只有「名字 + 初始值都看不出用途」才报。
  // 不报：循环变量、解构占位、_ 前缀、i/j/k/x/y/z、真正常量；回调参数/catch(e) 本来就不在变量声明范围内。
  // 单字母变量若初始值已经带了用途线索（Number(...)/String(...)/await loadX() 等），按误报处理，不报。
  for (const item of walkDeclarators(ast)) {
    const { node, parent, grandparent } = item;
    const id = node.id;
    if (!id || id.type !== 'Identifier') continue; // 解构声明占位不报
    const name = id.name;
    if (name.startsWith('_')) continue; // 约定忽略（含 _ 本身）
    if (isLoopVariable(parent, grandparent)) continue; // 循环变量 i/j/k/n 等一律不按命名问题报
    const kind = parent && parent.type === 'VariableDeclaration' ? parent.kind : '';
    const single = name.length === 1;
    const upper = single && /^[A-Z]$/.test(name);
    const allCapsMutable = !single && /^[A-Z][A-Z0-9_]*$/.test(name) && kind !== 'const';
    if (single && NAMING_ALLOWED.has(name.toLowerCase())) continue; // 坐标/循环约定
    if (upper && kind === 'const') continue; // 全大写且 const：真常量不报
    let reason = null;
    if (upper) {
      reason = t('变量 {name} 是全大写单字母但未声明为常量，看不出用途，建议改成有说明性的常量名', { name });
    } else if (allCapsMutable) {
      reason = t('变量 {name} 是全大写但声明为可变变量（非 const），看不出用途，建议改成有说明性的常量名', { name });
    } else if (single) {
      const init = node.init;
      const opaque = !init || NAMING_OPAQUE_INIT_TYPES.has(init.type);
      // 模块级 let 单字母即使有初始值也难判断用途（作用域大且可反复赋值）；
      // 函数内临时量若有 Number()/await loadX() 这类线索，按误报处理不报。
      const topLevelLet = kind === 'let' && isTopLevelVariable(parent, grandparent);
      if (!opaque && !topLevelLet) continue;
      reason = t('变量 {name} 看不出用途，建议改成能读懂用途的名字', { name });
    } else if (NAMING_NOISE.has(name)) {
      reason = t('变量 {name} 无信息量（data/temp/foo 这类名字看不出用途），建议改成能读懂用途的名字', { name });
    }
    if (!reason) continue;
    const line = id.loc ? id.loc.start.line : 0;
    emit('Q4.naming', 'low', line, reason, snippetAt(lines, line));
  }

  // 单字符函数名：只报真正的函数名（函数声明 / 方法 / 具名函数表达式）。
  // 箭头函数赋给变量属于变量命名问题，由上面的变量规则处理，避免同一处被报两次。
  for (const entry of functions) {
    const { node } = entry;
    let fname = '';
    if (node.id && node.id.type === 'Identifier') fname = node.id.name;
    else if (node.key && node.key.type === 'Identifier') fname = node.key.name;
    else if (node.key && node.key.type === 'StringLiteral') fname = node.key.value;
    if (!fname || fname.length !== 1) continue;
    if (fname.startsWith('_') || NAMING_ALLOWED.has(fname.toLowerCase())) continue;
    if (/^[A-Z]$/.test(fname)) continue; // 大写单字母函数名（类/构造函数约定）不报
    const line = node.loc ? node.loc.start.line : 0;
    emit('Q4.naming', 'low', line,
      t('函数 {name} 是单字符名，看不出用途，建议改成能读懂用途的名字', { name: fname }),
      snippetAt(lines, line));
  }

  // 规则 6 重复字符串字面量
  const dupes = [...strings.entries()]
    .map(([value, occurrences]) => [value, occurrences.slice().sort((a, b) => a - b)])
    .filter(([, occurrences]) => occurrences.length >= thresholds.duplicateStringCount)
    .sort((a, b) => (a[1][0] - b[1][0]) || (a[0] < b[0] ? -1 : 1));
  for (const [value, occurrences] of dupes) {
    const preview = safeText(value).slice(0, 40);
    emit('Q4.duplicate-string', 'low', occurrences[0],
      t('相同字符串字面量重复 {n} 处："{preview}"，建议提成常量', { n: occurrences.length, preview }),
      snippetAt(lines, occurrences[0]));
  }

  // 规则 7 any / as any / @ts-ignore（仅 ts/tsx）
  if (TS_EXT_RE.test(ext)) {
    for (const item of anyNodes) {
      const isAs = item.parent && item.parent.type === 'TSAsExpression' && item.key === 'typeAnnotation';
      const line = item.node.loc ? item.node.loc.start.line : 0;
      emit('Q4.ts-any', 'low', line,
        isAs ? t('使用了 as any，绕过类型检查') : t('使用了 any 类型，绕过类型检查'),
        snippetAt(lines, line));
    }
    for (const comment of ast.comments || []) {
      if (!/@ts-ignore\b/.test(String(comment.value || ''))) continue;
      const line = comment.loc ? comment.loc.start.line : 0;
      emit('Q4.ts-ignore', 'low', line,
        t('使用了 @ts-ignore 压制类型错误，建议修复根因或写明原因'),
        snippetAt(lines, line));
    }
  }

  return { skippedGenerated: false };
}

function walkDeclarators(ast) {
  const out = [];
  const stack = [{ node: ast.program, parent: null, grandparent: null }];
  while (stack.length) {
    const item = stack.pop();
    if (item.node.type === 'VariableDeclarator') out.push(item);
    forEachChild(item.node, (child) => {
      stack.push({ node: child, parent: item.node, grandparent: item.parent });
    });
  }
  return out;
}

function isLoopVariable(parent, grandparent) {
  if (!parent || parent.type !== 'VariableDeclaration') return false;
  return Boolean(grandparent && (
    grandparent.type === 'ForStatement'
    || grandparent.type === 'ForInStatement'
    || grandparent.type === 'ForOfStatement'
  ));
}

function isTopLevelVariable(parent, grandparent) {
  if (!parent || parent.type !== 'VariableDeclaration') return false;
  return Boolean(grandparent && (
    grandparent.type === 'Program'
    || grandparent.type === 'ExportNamedDeclaration'
    || grandparent.type === 'ExportDefaultDeclaration'
  ));
}

// rust-code-analysis 是可选增强：查得到就试一次，任何失败静默回落到纯 Babel 结果。
// 不能用 spawnSync：它会把 Electron 主线程阻塞到 15 秒（src/run-async.mjs 的约定）。
async function tryRustMetrics(projectDir) {
  try {
    const binary = findBinary('rust-code-analysis');
    if (!binary) return null;
    const stdout = await new Promise((resolve) => {
      let out = '';
      let done = false;
      const proc = spawn(binary, ['-O', 'json', '-p', projectDir], { windowsHide: true });
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try { proc.kill(); } catch { /* 已退出 */ }
        finish(null);
      }, 15000);
      timer.unref?.();
      proc.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.length > 16 * 1024 * 1024) {
          try { proc.kill(); } catch { /* 已退出 */ }
          finish(null);
        }
      });
      proc.on('error', () => finish(null));
      proc.on('close', (code) => finish(code === 0 && out ? out : null));
    });
    if (!stdout) return null;
    const json = JSON.parse(stdout);
    const spaces = Array.isArray(json && json.spaces) ? json.spaces.length : undefined;
    return { available: true, spaces };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 入口

export async function checkReadability(projectDir, opts = {}) {
  const findings = [];
  const warnings = [];
  const thresholds = normalizeThresholds(opts.thresholds, warnings);
  const globalCap = reportCap(opts.reportCaps, 'Q4.perRule', thresholds.maxFindingsPerRuleGlobal);
  // 单文件单规则上限：默认 Infinity；显式 reportCaps["Q4.perFile"] 才截断（旧的 thresholds.maxFindingsPerRule 仅作兼容回落）
  const perFileCapConfig = reportCap(opts.reportCaps, 'Q4.perFile', Infinity);
  const perFile = perFileCapConfig === Infinity ? null : { cap: perFileCapConfig, totals: new Map() };
  const excludes = Array.isArray(opts.excludes) ? opts.excludes : [];
  const root = projectDir || '.';

  const {
    files, skipped: tooBig, pruned, fixtures, overLimit,
  } = await listTextFiles(root, excludes, {
    codeOnly: true,
    maxBytes: thresholds.maxFileBytes,
    maxFiles: thresholds.maxFiles,
    maxDepth: WALK_DEPTH_LIMIT,
    includeFixtures: opts.includeFixtures === true,
  });
  if (overLimit) {
    warnings.push(t('Q4：代码文件超过上限 {max} 个，只扫描前 {max} 个', { max: thresholds.maxFiles }));
  }
  const pword = prunedWarning(pruned);
  if (pword) warnings.push(t('Q4：{msg}', { msg: pword }));
  const fword = fixturesWarning(fixtures);
  if (fword) warnings.push(t('Q4：{msg}', { msg: fword }));
  if (tooBig.length) {
    warnings.push(t('Q4：跳过超过 1MB 的文件 {n} 个：{list}', {
      n: tooBig.length,
      list: tooBig.slice(0, 3).join('、') + (tooBig.length > 3 ? '…' : ''),
    }));
  }
  if (!files.length) {
    warnings.push(t('Q4：未找到可扫描的代码文件（ts/js/mjs/cjs/jsx/tsx）'));
    return { checkId: CHECK_ID, findings, coverageGap: null, warnings };
  }

  let skippedGenerated = 0;
  for (const abs of files) {
    const file = path.relative(root, abs).replace(/\\/g, '/');
    let text;
    try {
      text = await readFile(abs, 'utf8');
    } catch {
      warnings.push(t('Q4：无法读取 {file}，已跳过', { file }));
      continue;
    }
    const emit = makeEmitter(findings, warnings, file, thresholds, perFile);
    const result = analyzeFile({
      file,
      ext: path.extname(abs).toLowerCase(),
      text,
      thresholds,
      emit,
      warnings,
    });
    if (result.skippedGenerated) skippedGenerated++;
  }
  if (skippedGenerated) {
    warnings.push(t('Q4：跳过生成/压缩文件 {n} 个', { n: skippedGenerated }));
  }

  findings.sort((a, b) => (
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
    || (a.line - b.line)
    || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)
  ));

  // 单文件单规则截断：warning 与 ## Not covered 都要写清「哪个文件、哪条规则、总量、上限、未列出条数」
  const reportTruncations = [];
  if (perFile) {
    for (const [key, total] of perFile.totals) {
      if (total <= perFile.cap) continue;
      const [file, rule] = key.split('\u0000');
      const tr = truncationRecord({
        checkId: CHECK_ID,
        rule,
        configKey: 'Q4.perFile',
        total,
        reported: perFile.cap,
        cap: perFile.cap,
        file,
      });
      reportTruncations.push(tr);
      warnings.push(truncationWarning(tr));
    }
  }

  // 全局限额：默认 Infinity（不截断），findings 原样全部保留；
  // 只有显式配置 reportCaps["Q4.perRule"] 时才按规则取前 N 条，并在 warning/Not covered 点名总量。
  const totals = new Map();
  for (const f of findings) totals.set(f.rule, (totals.get(f.rule) || 0) + 1);
  let kept = findings;
  if (globalCap !== Infinity) {
    kept = [];
    const keptCounts = new Map();
    for (const f of findings) {
      const count = keptCounts.get(f.rule) || 0;
      keptCounts.set(f.rule, count + 1);
      if (count < globalCap) kept.push(f);
    }
    for (const [rule, total] of totals) {
      if (total <= globalCap) continue;
      const tr = truncationRecord({
        checkId: CHECK_ID,
        rule,
        configKey: 'Q4.perRule',
        total,
        reported: globalCap,
        cap: globalCap,
      });
      reportTruncations.push(tr);
      warnings.push(truncationWarning(tr));
    }
  }
  // 未截断但单规则命中偏多：保留噪声提示，条目一条不少
  for (const [rule, total] of totals) {
    if (reportTruncations.some((tr) => tr.rule === rule)) continue;
    if (total > DEFAULT_NOISE_HINTS['Q4.perRule']) {
      warnings.push(noiseWarning({
        checkId: CHECK_ID, rule, total, configKey: 'Q4.perRule',
      }));
    }
  }
  const out = { checkId: CHECK_ID, findings: kept, coverageGap: null, warnings };
  // 只有真的发生截断才加字段：未配置时返回形状与旧版一致
  if (reportTruncations.length) out.reportTruncations = reportTruncations;
  if (opts.rustMetrics !== false) {
    const rust = await tryRustMetrics(root);
    if (rust) out.rustMetrics = rust;
  }
  return out;
}

// 与 Q3（checkMetrics / checkQ3）同构的别名，方便按矩阵编号接线
export const checkQ4 = checkReadability;
export const READABILITY_DEFAULT_THRESHOLDS = DEFAULT_THRESHOLDS;
