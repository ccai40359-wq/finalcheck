// S7 的 Electron IPC 权限面扫描（假通过治理）。
//
// ipcMain.handle / ipcMain.on 是桌面应用真实的权限入口：渲染层只需一个 channel
// 字符串就能触发主进程的文件/命令/网络能力。S7 原来只看 HTTP 路由，桌面项目
// 会因此结构误判成「路由表为空 → 无法验收」。这里做静态提取：
//   - 找出 ipcMain.handle/on('channel', handler) 的 channel、file、line、handler 片段；
//   - 判 handler 有无校验迹象（路径闸 / schema / senderFrame / typeof 参数检查）；
//   - 无任何迹象 → medium + force=check 的 finding 转人工确认（v1 不自动卡结论）；
//   - handler 是变量引用且无法在文件内解析 → warnings 点名，不猜。
// 只读源码，不执行、不联网；解析失败按文件 warning，绝不抛出。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';

// 构建产物/依赖/发布目录里的副本不是真实权限面；release* 覆盖 release-0110 等快照目录。
const SKIP_DIR_NAMES = new Set(['node_modules', 'out', 'dist', 'coverage', 'build', 'vendor']);
const SCANNED_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);
const MAX_FILE_SIZE = 2_000_000;
const FINDING_MESSAGE = 'IPC 通道未检出参数/路径校验——请人工确认；确认有校验可加 finalcheck:allow';

function isSkippedDir(name) {
  return SKIP_DIR_NAMES.has(name) || name.startsWith('release');
}

function isExcluded(rel, excludes) {
  return excludes.some((x) => {
    const n = String(x).replace(/\\/g, '/');
    const r = rel.replace(/\\/g, '/');
    return r === n || r.startsWith(n + '/');
  });
}

function isDesktopMainSource(rel) {
  return rel.replace(/\\/g, '/').startsWith('desktop/src/main/') && /\.mjs$/i.test(rel);
}

function walk(node, cb) {
  if (!node || typeof node.type !== 'string') return;
  cb(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' ||
        key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walk(c, cb);
    } else if (child && typeof child === 'object') {
      walk(child, cb);
    }
  }
}

function memberPropName(node) {
  if (!node || !node.property) return null;
  const p = node.property;
  if (p.type === 'Identifier') return p.name;
  if (p.type === 'StringLiteral') return p.value;
  return null;
}

function isFunctionNode(node) {
  return !!node && (node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration');
}

function staticChannel(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? node.quasis[0]?.value?.raw ?? null;
  }
  return null;
}

function paramNames(fn) {
  const names = [];
  for (const p of fn.params || []) {
    if (p.type === 'Identifier') names.push(p.name);
    else if (p.type === 'AssignmentPattern' && p.left && p.left.type === 'Identifier') names.push(p.left.name);
    else if (p.type === 'RestElement' && p.argument && p.argument.type === 'Identifier') names.push(p.argument.name);
  }
  return names;
}

const RE_PATH_ASSERT = /\b(?:assertArtifactPath|assertPathAllowed|resolveSafePath)\s*\(/;
const RE_SENDER_FRAME = /\bsenderFrame\b/;
const RE_ZOD = /\bzod\b/i;
const RE_ZOD_CHAIN = /\bz\s*\.\s*(?:object|string|number|boolean|array|enum|literal|union|coerce|preprocess|tuple|record|map|set|bigint|date|unknown|any)\s*\(/;
const RE_JOI = /\bJoi\b|\bjoi\b/;
const RE_YUP = /\bYup\b|\byup\b/;
const RE_SCHEMA_PARSE = /\b(?:schema|Schema|validator|Validator)[A-Za-z0-9_$]*\s*\.\s*(?:parse|safeParse|validate)\s*\(/;
const RE_PATH_RESOLVE = /\bpath\s*\.\s*resolve\s*\(/;
const RE_WHITELIST = /\b(?:white[_-]?list|allow[_-]?list|allowed[_-]?(?:paths?|roots?|dirs?)|isInside|isWithin|startsWith|includes|safeRoots)\b/i;

function hasValidation(handlerNode, text) {
  if (RE_PATH_ASSERT.test(text)) return 'path-assert';
  if (RE_SENDER_FRAME.test(text)) return 'senderFrame';
  if (RE_ZOD.test(text) || RE_ZOD_CHAIN.test(text)) return 'zod';
  if (RE_JOI.test(text)) return 'joi';
  if (RE_YUP.test(text)) return 'yup';
  if (RE_SCHEMA_PARSE.test(text)) return 'schema-parse';
  if (RE_PATH_RESOLVE.test(text) && RE_WHITELIST.test(text)) return 'path-whitelist';
  // 只把「handler 自己的参数」上的 typeof 检查算数；handler 内部别的变量不算。
  const params = paramNames(handlerNode);
  for (const name of params) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\btypeof\\s+${escaped}\\b`).test(text)) return 'typeof-param';
  }
  return null;
}

function excerpt(code, node, max = 220) {
  const raw = code.slice(node.start ?? 0, node.end ?? 0).replace(/\s+/g, ' ').trim();
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

function collectFunctionDefs(ast) {
  const defs = new Map();
  walk(ast.program, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id && node.id.type === 'Identifier') {
      defs.set(node.id.name, node);
    } else if (node.type === 'VariableDeclarator' && node.id && node.id.type === 'Identifier' && isFunctionNode(node.init)) {
      defs.set(node.id.name, node.init);
    }
  });
  return defs;
}

// 识别 `import { ipcMain } from 'electron'` / `const { ipcMain: ipc } = require('electron')`
// 的本地别名；默认仍认名字 ipcMain。
function collectIpcMainAliases(ast) {
  const names = new Set(['ipcMain']);
  const isElectron = (src) => typeof src === 'string' && src.replace(/\\/g, '/').endsWith('electron');
  walk(ast.program, (node) => {
    if (node.type === 'ImportDeclaration' && isElectron(node.source?.value)) {
      for (const sp of node.specifiers || []) {
        if (sp.type === 'ImportSpecifier') {
          const imported = sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value;
          if (imported === 'ipcMain') names.add(sp.local.name);
        }
      }
      return;
    }
    if (node.type === 'VariableDeclarator' && node.init && node.id?.type === 'ObjectPattern') {
      const c = node.init;
      const fromElectron = (c.type === 'CallExpression' && c.callee.type === 'Identifier' && c.callee.name === 'require' &&
        isElectron(c.arguments?.[0]?.value)) ||
        (c.type === 'MemberExpression' && c.property?.name === 'ipcMain');
      if (!fromElectron) return;
      for (const p of node.id.properties || []) {
        if (p.type !== 'ObjectProperty') continue;
        const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : null;
        if (key === 'ipcMain' && p.value.type === 'Identifier') names.add(p.value.name);
      }
    }
  });
  return names;
}

function ipcMethodOf(node, ipcNames) {
  if (!node || node.type !== 'CallExpression' || !node.callee) return null;
  let callee = node.callee;
  if (callee.type === 'OptionalMemberExpression' || callee.type === 'OptionalCallExpression') {
    if (callee.type === 'OptionalCallExpression') callee = callee.callee;
  }
  if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return null;
  const prop = memberPropName(callee);
  if (prop !== 'handle' && prop !== 'on') return null;
  const obj = callee.object;
  if (obj.type === 'Identifier' && ipcNames.has(obj.name)) return prop;
  // electron.ipcMain.handle / require('electron').ipcMain.handle
  if ((obj.type === 'MemberExpression' || obj.type === 'OptionalMemberExpression') && memberPropName(obj) === 'ipcMain') return prop;
  return null;
}

function analyzeFile({ abs, rel, code, excludes, warnings }) {
  let ast;
  try {
    ast = parse(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: ['jsx', 'typescript'],
    });
    if (ast.errors && ast.errors.length) warnings.push(`${rel}: IPC 扫描语法错误（已尽量恢复），结果可能不完整`);
  } catch (e) {
    warnings.push(`${rel}: IPC 扫描解析失败（${e.message}），已跳过`);
    return { handlers: [], findings: [] };
  }

  const ipcNames = collectIpcMainAliases(ast);
  const defs = collectFunctionDefs(ast);
  const handlers = [];
  const findings = [];

  walk(ast.program, (node) => {
    if (node.type !== 'CallExpression') return;
    const method = ipcMethodOf(node, ipcNames);
    if (!method) return;
    const line = node.loc && node.loc.start ? node.loc.start.line : 0;
    const args = node.arguments || [];
    const channel = staticChannel(args[0]);
    if (channel == null) {
      warnings.push(`${rel}:${line}: ipcMain.${method}() 的通道名不是静态字符串，无法判定，请人工确认`);
      handlers.push({ channel: null, method, file: rel, line, validated: false, handlerSnippet: '', handler: '' });
      return;
    }

    const arg = args[1];
    if (!arg) {
      warnings.push(`${rel}:${line}: IPC 通道 ${channel} 没有 handler 参数，无法静态判定`);
      handlers.push({ channel, method, file: rel, line, validated: false, handlerSnippet: '', handler: '' });
      return;
    }
    let handlerNode = null;
    if (isFunctionNode(arg)) handlerNode = arg;
    else if (arg.type === 'Identifier' && defs.has(arg.name)) handlerNode = defs.get(arg.name);
    if (!handlerNode) {
      const ref = arg.type === 'Identifier' ? `变量引用 ${arg.name}` : `表达式（${arg.type}）`;
      warnings.push(`${rel}:${line}: IPC 通道 ${channel} 的 handler 是${ref}，无法静态解析，请人工确认`);
      handlers.push({ channel, method, file: rel, line, validated: false, handlerSnippet: '', handler: '' });
      return;
    }

    const text = code.slice(handlerNode.start ?? 0, handlerNode.end ?? 0);
    const validation = hasValidation(handlerNode, text);
    const handlerSnippet = excerpt(code, handlerNode);
    handlers.push({ channel, method, file: rel, line, validated: Boolean(validation), handlerSnippet, handler: handlerSnippet });
    if (validation) return; // 有校验迹象：不报，留给人工确认具体强度
    if (isExcluded(rel, excludes)) return;
    if (code.split('\n')[line - 1]?.includes('finalcheck:allow') || text.includes('finalcheck:allow')) return;
    findings.push({
      checkId: 'S7',
      severity: 'medium',
      force: 'check',
      file: rel,
      line,
      rule: 'S7.ipc-no-validation',
      snippet: `${channel} ${handlerSnippet}`.slice(0, 260),
      message: FINDING_MESSAGE,
      source: 'program',
    });
  });

  return { handlers, findings };
}

function collectSourceFiles(projectDir, warnings) {
  const files = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (ent.name.startsWith('.')) continue; // .git / 隐藏状态目录
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!isSkippedDir(ent.name)) visit(abs);
        continue;
      }
      if (!SCANNED_EXTS.has(path.extname(ent.name).toLowerCase())) continue;
      const rel = path.relative(projectDir, abs).split(path.sep).join('/');
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_SIZE) continue;
      let code;
      try {
        code = readFileSync(abs, 'utf8');
      } catch (e) {
        if (isDesktopMainSource(rel)) warnings.push(`${rel}: 无法读取（${e.message}），IPC 扫描已跳过`);
        continue;
      }
      // 先限定 Electron 主进程文件：desktop/src/main/**/*.mjs，或任何含 ipcMain 的源码。
      if (!isDesktopMainSource(rel) && !code.includes('ipcMain')) continue;
      files.push({ abs, rel, code });
    }
  };
  visit(projectDir);
  return files;
}

/**
 * 扫描项目里的 Electron IPC 权限面（静态、只读、从不抛出）。
 * 纯同步实现：调用方可以 `scanIpc(dir)` 直接取结果，也可以 `await`（非 Promise 也可 await）。
 * @param {string} projectDir
 * @param {{ excludes?: string[] }} [options]
 * @returns {{handlers: object[], findings: object[], warnings: string[]}}
 */
export function scanIpc(projectDir, { excludes = [] } = {}) {
  const warnings = [];
  const handlers = [];
  const findings = [];
  try {
    const rootDir = path.resolve(String(projectDir ?? '.'));
    let st;
    try {
      st = statSync(rootDir);
    } catch {
      warnings.push(`项目目录不存在：${rootDir}`);
      return { handlers, findings, warnings };
    }
    if (!st.isDirectory()) {
      warnings.push(`项目路径不是目录：${rootDir}`);
      return { handlers, findings, warnings };
    }
    for (const file of collectSourceFiles(rootDir, warnings)) {
      if (isExcluded(file.rel, excludes)) continue; // exclude 的文件连 handler 都不算进权限面
      const r = analyzeFile({ ...file, excludes, warnings });
      handlers.push(...r.handlers);
      findings.push(...r.findings);
    }
  } catch (e) {
    warnings.push(`IPC 扫描失败：${e && e.message ? e.message : e}`);
  }
  return { handlers, findings, warnings };
}
