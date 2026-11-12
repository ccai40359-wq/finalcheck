// Static Express route-table extractor for the FinalCheck engine (S1 baseline).
// Parses source with @babel/parser (no regex splitting), follows app.use() /
// router.use() mounts across require/import (including TS ".js" -> ".ts" paths
// and router factory functions), extracts router.route() chains, and fails
// open per file: anything unrecognized lands in `warnings`, never throws.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import { isPublicPath, isRelativeSource, joinPath, prefixMatches, staticPathValue } from './route-path.mjs';
import { sourceModel, walkSource, isFunction } from './source-analysis.mjs';

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);
// Loose match over the spec'd guard names (auth/requireAuth/.../jwt/passport/session).
const GUARD_RE = /(auth|jwt|passport|session|verifytoken|checktoken|ensureloggedin|isloggedin|login|protect)/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'out', 'vendor', '.next', '.cache']);
const SCANNED_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);
const MAX_DEPTH = 16;
const MAX_CHAIN = 50;
// File-level pre-screen: only parse files that plausibly touch Express.
// Non-Express files (Angular frontends etc.) are skipped silently so their
// syntax errors never flood S1 warnings; Express-referencing files that fail
// to parse still warn (a real route file's parse failure is a signal).
const EXPRESS_REF_RE = /from\s+['"]express|require\(\s*['"]express|express\(\)/i;

/* ---------- generic AST walk ---------- */

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

/* ---------- AST helpers ---------- */

function memberPropName(node) {
  const p = node.property;
  if (p.type === 'Identifier') return p.name;
  if (p.type === 'StringLiteral') return p.value;
  return null;
}

function isRequireCall(n) {
  return !!n && n.type === 'CallExpression' && n.callee.type === 'Identifier' &&
    n.callee.name === 'require' && n.arguments.length > 0 && n.arguments[0].type === 'StringLiteral';
}

function isRouterFactory(n) {
  if (!n || n.type !== 'CallExpression') return false;
  const c = n.callee;
  if (c.type === 'Identifier' && c.name === 'Router') return true;
  if (c.type !== 'MemberExpression' || memberPropName(c) !== 'Router') return false;
  const o = c.object;
  return (o.type === 'Identifier' && o.name === 'express') || (isRequireCall(o) && o.arguments[0].value === 'express');
}

function isExpressAppCall(n) {
  if (!n || n.type !== 'CallExpression') return false;
  if (n.callee.type === 'Identifier' && n.callee.name === 'express') return true;
  return isRequireCall(n.callee) && n.callee.arguments[0].value === 'express';
}

function isFunctionNode(n) {
  return n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration';
}

function exprName(n) {
  if (!n) return null;
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'MemberExpression') {
    const obj = n.object.type === 'Identifier' ? n.object.name : exprName(n.object);
    const prop = memberPropName(n);
    return obj && prop ? `${obj}.${prop}` : null;
  }
  if (n.type === 'CallExpression') return exprName(n.callee);
  return null;
}

// Middleware arg -> list of names (arrays flatten); null when unnamed (inline fn).
function mwNameOf(n) {
  if (!n) return null;
  if (n.type === 'ArrayExpression') {
    const names = [];
    for (const e of n.elements) {
      const m = mwNameOf(e);
      if (m) names.push(...m);
    }
    return names.length ? names : null;
  }
  if (n.type === 'SpreadElement') return null;
  // Anonymous inline middleware: name it by the first guard-ish identifier it
  // touches (e.g. an inline arrow calling sessionGuard counts as a guard).
  if (isFunctionNode(n) && n.body) {
    const found = [];
    try {
      walk(n.body, (x) => {
        if (!found.length && x.type === 'Identifier' && GUARD_RE.test(x.name)) found.push(x.name);
      });
    } catch {
      /* ignore scan failures */
    }
    return found.length ? [found[0]] : null;
  }
  const name = exprName(n);
  return name ? [name] : null;
}

// app.get('/x', mw1, [mw2], handler): flatten the chain, last entry is the terminal handler.
function routeMwNames(mwArgs) {
  const chain = [];
  for (const a of mwArgs) {
    if (a && a.type === 'ArrayExpression') {
      for (const e of a.elements) chain.push(mwNameOf(e));
    } else {
      chain.push(mwNameOf(a));
    }
  }
  if (chain.length) chain.pop();
  const names = [];
  for (const item of chain) if (item) names.push(...item);
  return names;
}


// Resolve "./x.js" also to "./x.ts" / ".tsx" (TS ESM convention), etc.
function resolveImportPath(fromDir, source) {
  if (!isRelativeSource(source)) return null;
  const base = path.resolve(fromDir, source);
  const candidates = [base];
  const ext = path.extname(base).toLowerCase();
  const stem = ext ? base.slice(0, -ext.length) : base;
  if (ext === '.js') candidates.push(stem + '.ts', stem + '.tsx');
  else if (ext === '.mjs') candidates.push(stem + '.mts');
  else if (ext === '.cjs') candidates.push(stem + '.cts');
  for (const e of ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']) candidates.push(base + e);
  for (const e of ['.js', '.mjs', '.cjs', '.ts']) candidates.push(path.join(base, 'index' + e));
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        if (statSync(c).isFile()) return c;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/* ---------- per-file analysis ---------- */

function bindRequire(pattern, source, imports) {
  if (pattern.type === 'Identifier') {
    imports.set(pattern.name, { source, name: 'default' });
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const p of pattern.properties) {
      if (p.type !== 'ObjectProperty') continue;
      const key = p.key.type === 'Identifier' ? p.key.name : (p.key.type === 'StringLiteral' ? p.key.value : null);
      if (key == null || p.value.type !== 'Identifier') continue;
      imports.set(p.value.name, { source, name: key });
    }
  }
}

function putExport(exportsMap, slot, right) {
  if (!right) return;
  const assign = (val) => {
    if (slot === 'default') exportsMap.default = val;
    else {
      exportsMap.named.set(slot, val);
      exportsMap.defaultObject.set(slot, val);
    }
  };
  if (right.type === 'Identifier') return assign(right.name);
  if (right.type === 'FunctionDeclaration' && right.id) return assign(right.id.name);
  if (isRequireCall(right)) return assign({ reexport: right.arguments[0].value, name: 'default' });
  if (right.type === 'ObjectExpression') {
    for (const p of right.properties) {
      if (p.type !== 'ObjectProperty') continue;
      const key = p.key.type === 'Identifier' ? p.key.name : (p.key.type === 'StringLiteral' ? p.key.value : null);
      if (key == null) continue;
      if (p.value.type === 'Identifier') {
        exportsMap.named.set(key, p.value.name);
        exportsMap.defaultObject.set(key, p.value.name);
      } else if (isRequireCall(p.value)) {
        const re = { reexport: p.value.arguments[0].value, name: 'default' };
        exportsMap.named.set(key, re);
        exportsMap.defaultObject.set(key, re);
      }
    }
  }
  // other value shapes stay unresolvable; mount-time warning explains
}

// A named function whose body creates an express.Router() is a router factory:
// `export function healthRouter() { const r = Router(); ...; return r; }`.
// The routes live on the inner var, scoped to the factory body.
function registerFunctionLike(name, body, functions, routerFactories) {
  if (!name || !body) return;
  functions.add(name);
  let inner = null;
  try {
    walk(body, (n) => {
      if (!inner && n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && isRouterFactory(n.init)) {
        inner = n.id.name;
      }
    });
  } catch {
    /* ignore scan failures */
  }
  if (inner) routerFactories.set(name, { var: inner, start: body.start, end: body.end });
}

// Walk down a `.get(...)`/`.post(...)` chain to its `route('/path')` base.
function findRouteBase(call) {
  let obj = call && call.callee && call.callee.type === 'MemberExpression' ? call.callee.object : null;
  let hops = 0;
  while (obj && obj.type === 'CallExpression' && hops < MAX_CHAIN) {
    hops++;
    if (obj.callee.type === 'MemberExpression' && memberPropName(obj.callee) === 'route') {
      if (obj.arguments.length === 1 && staticPathValue(obj.arguments[0]) !== undefined) return obj;
      return null; // route() without a single static path: not an Express route chain
    }
    obj = obj.callee && obj.callee.type === 'MemberExpression' ? obj.callee.object : null;
  }
  return null;
}

function analyzeFile(abs, rel, warnings) {
  let code;
  try {
    code = readFileSync(abs, 'utf8');
  } catch (e) {
    warnings.push(`${rel}: unreadable file, skipped (${e.message})`);
    return null;
  }
  if (code.length > 2_000_000) {
    warnings.push(`${rel}: file too large, skipped`);
    return null;
  }
  if (!EXPRESS_REF_RE.test(code)) return null; // non-Express file: skip without warnings
  let ast;
  try {
    ast = parse(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: ['jsx', 'typescript'],
    });
    if (ast.errors && ast.errors.length) warnings.push(`${rel}: syntax error(s) recovered; extraction may be partial`);
  } catch (e) {
    warnings.push(`${rel}: parse error, skipped (${e.message})`);
    return null;
  }

  const imports = new Map(); // local name -> { source, name, member? }
  const routers = new Set(); // vars created via express.Router()
  const apps = new Set(); // vars created via express()
  const functions = new Set(); // named function-like vars (plain middleware candidates)
  const routerFactories = new Map(); // factory name -> { var, start, end }
  const exportsMap = { default: null, named: new Map(), defaultObject: new Map() };
  const events = [];
  const routeBases = []; // starts of X.route('/path') calls
  const chainedBases = new Set(); // bases that have at least one chained method call

  walk(ast.program, (node) => {
    if (node.type === 'ImportDeclaration') {
      for (const sp of node.specifiers) {
        if (sp.type === 'ImportDefaultSpecifier') imports.set(sp.local.name, { source: node.source.value, name: 'default' });
        else if (sp.type === 'ImportNamespaceSpecifier') imports.set(sp.local.name, { source: node.source.value, name: 'namespace' });
        else if (sp.type === 'ImportSpecifier') {
          const imported = sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value;
          imports.set(sp.local.name, { source: node.source.value, name: imported });
        }
      }
      return;
    }

    if (node.type === 'VariableDeclarator' && node.init) {
      if (isRequireCall(node.init)) bindRequire(node.id, node.init.arguments[0].value, imports);
      else if (node.id.type === 'Identifier') {
        if (node.init.type === 'MemberExpression' && !node.init.computed && isRequireCall(node.init.object)) {
          const prop = memberPropName(node.init);
          imports.set(node.id.name, { source: node.init.object.arguments[0].value, name: 'default', ...(prop ? { member: prop } : {}) });
        } else if (isRouterFactory(node.init)) routers.add(node.id.name);
        else if (isExpressAppCall(node.init)) apps.add(node.id.name);
        else if (isFunctionNode(node.init)) registerFunctionLike(node.id.name, node.init.body, functions, routerFactories);
      }
      return;
    }

    if (node.type === 'FunctionDeclaration') {
      registerFunctionLike(node.id ? node.id.name : null, node.body, functions, routerFactories);
      return;
    }

    if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'MemberExpression') {
      const left = node.left;
      if (left.object.type === 'Identifier' && left.object.name === 'module' && memberPropName(left) === 'exports') {
        putExport(exportsMap, 'default', node.right);
      } else if (left.object.type === 'MemberExpression' && left.object.object.type === 'Identifier' &&
                 left.object.object.name === 'module' && memberPropName(left.object) === 'exports') {
        const key = memberPropName(left);
        if (key) putExport(exportsMap, key, node.right);
      } else if (left.object.type === 'Identifier' && left.object.name === 'exports') {
        const key = memberPropName(left);
        if (key) putExport(exportsMap, key, node.right);
      }
      return;
    }

    if (node.type === 'ExportDefaultDeclaration') {
      putExport(exportsMap, 'default', node.declaration);
      return;
    }

    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration && node.declaration.type === 'VariableDeclaration') {
        for (const d of node.declaration.declarations) {
          if (d.id.type === 'Identifier') exportsMap.named.set(d.id.name, d.id.name);
        }
      }
      if (node.declaration && node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
        exportsMap.named.set(node.declaration.id.name, node.declaration.id.name);
      }
      for (const sp of node.specifiers || []) {
        if (sp.type === 'ExportNamespaceSpecifier') continue; // export * as ns from '...' — not a router export
        const exported = sp.exported.type === 'Identifier' ? sp.exported.name : sp.exported.value;
        const local = sp.local && sp.local.type === 'Identifier' ? sp.local.name : (sp.local ? sp.local.value : null);
        if (local == null) continue;
        if (node.source) exportsMap.named.set(exported, { reexport: node.source.value, name: local });
        else exportsMap.named.set(exported, local);
      }
      return;
    }

    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const propName = memberPropName(node.callee);
      const objNode = node.callee.object;

      // Chained form: router.route('/x').get(mw, h).post(h2)
      if (objNode && objNode.type === 'CallExpression' && propName && (ROUTE_METHODS.has(propName) || propName === 'all')) {
        const base = findRouteBase(node);
        if (base) {
          const pathVal = staticPathValue(base.arguments[0]);
          if (pathVal !== undefined) {
            events.push({
              kind: 'route',
              obj: base.callee.object.type === 'Identifier' ? base.callee.object.name : null,
              method: propName,
              pathOverride: pathVal,
              argNodes: node.arguments,
              mwNames: routeMwNames(node.arguments),
              // use the method token position: all chained calls share the chain's start
              start: node.callee.property && typeof node.callee.property.start === 'number' ? node.callee.property.start : 0,
              line: node.loc && node.loc.start ? node.loc.start.line : 0,
            });
            chainedBases.add(base.start);
          }
        }
      }

      // route() base with a single static path but no chained methods → dead assembly, warn.
      if (propName === 'route' && objNode.type === 'Identifier' && node.arguments.length === 1 && staticPathValue(node.arguments[0]) !== undefined) {
        routeBases.push(typeof node.start === 'number' ? node.start : 0);
      }

      // Direct form: app.get(...) / router.use(...)
      if (objNode.type === 'Identifier' && propName && (ROUTE_METHODS.has(propName) || propName === 'use' || propName === 'all')) {
        events.push({
          kind: propName === 'use' ? 'use' : 'route',
          obj: objNode.name,
          method: propName,
          argNodes: node.arguments,
          mwNames: propName === 'use' ? null : routeMwNames(node.arguments.slice(1)),
          start: typeof node.start === 'number' ? node.start : 0,
          line: node.loc && node.loc.start ? node.loc.start.line : 0,
        });
      }
    }
  });

  for (const b of routeBases) {
    if (!chainedBases.has(b)) warnings.push(`${rel}: route() call without chained method calls; skipped`);
  }
  events.sort((a, b) => a.start - b.start);
  return { abs, rel, imports, routers, apps, functions, routerFactories, exports: exportsMap, events };
}

/* ---------- mount resolution & tree emission ---------- */

// Use-arg -> mount target ({local}|{localFactory}|{import}) or null (plain middleware).
function classifyTarget(file, n) {
  if (!n) return null;
  if (n.type === 'Identifier') {
    if (file.routers.has(n.name) || file.apps.has(n.name)) return { local: n.name };
    if (file.routerFactories.has(n.name)) return { localFactory: n.name };
    const imp = file.imports.get(n.name);
    if (imp) return { import: { source: imp.source, name: imp.name, member: imp.member } };
    return null;
  }
  if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier') {
    const prop = memberPropName(n);
    if (!prop || file.routers.has(n.object.name) || file.apps.has(n.object.name) || file.routerFactories.has(n.object.name)) return null;
    const imp = file.imports.get(n.object.name);
    if (imp) return { import: { source: imp.source, name: imp.name, member: prop } };
    return null;
  }
  if (n.type === 'CallExpression') {
    const c = n.callee;
    if (c.type === 'Identifier') {
      if (file.routerFactories.has(c.name)) return { localFactory: c.name };
      const imp = file.imports.get(c.name);
      if (imp) return { import: { source: imp.source, name: imp.name, member: imp.member } };
      return null;
    }
    if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier') {
      const prop = memberPropName(c);
      if (!prop || file.routers.has(c.object.name) || file.apps.has(c.object.name) || file.routerFactories.has(c.object.name)) return null;
      const imp = file.imports.get(c.object.name);
      if (imp) return { import: { source: imp.source, name: imp.name, member: prop } };
    }
    return null;
  }
  if (isRequireCall(n)) return { import: { source: n.arguments[0].value, name: 'default' } };
  if (n.type === 'MemberExpression' && !n.computed && isRequireCall(n.object)) {
    const prop = memberPropName(n);
    if (prop) return { import: { source: n.object.arguments[0].value, name: 'default', member: prop } };
  }
  return null;
}

function analyzeCached(abs, ctx) {
  if (ctx.cache.has(abs)) return ctx.cache.get(abs);
  let analysis = null;
  try {
    const rel = path.relative(ctx.rootDir, abs).split(path.sep).join('/');
    analysis = analyzeFile(abs, rel, ctx.warnings);
  } catch (e) {
    ctx.warnings.push(`${abs}: unexpected analysis failure (${e && e.message ? e.message : e})`);
  }
  ctx.cache.set(abs, analysis);
  return analysis;
}

// Returns { file, varName, kind: 'router'|'factory'|'function' } or null.
function resolveTargetFile(fromFile, imp, ctx, line) {
  if (!isRelativeSource(imp.source)) return null; // third-party package: not statically followable
  let curFile = fromFile;
  let curImp = { source: imp.source, name: imp.name, member: imp.member };
  const seen = new Set();
  for (;;) {
    const abs = resolveImportPath(path.dirname(curFile.abs), curImp.source);
    if (!abs) {
      ctx.warnings.push(`${fromFile.rel}:${line}: cannot resolve mount import "${curImp.source}"`);
      return null;
    }
    const file = analyzeCached(abs, ctx);
    if (!file) return null;
    const key = `${abs}#${curImp.name}#${curImp.member || ''}`;
    if (seen.has(key)) {
      ctx.warnings.push(`${fromFile.rel}:${line}: circular export chain while resolving "${curImp.source}"`);
      return null;
    }
    seen.add(key);

    let varName;
    if (curImp.member) {
      varName = file.exports.defaultObject.get(curImp.member);
      if (varName == null) varName = file.exports.named.get(curImp.member);
      if (varName == null) {
        ctx.warnings.push(`${fromFile.rel}:${line}: ${file.rel} has no export "${curImp.member}"`);
        return null;
      }
    } else if (curImp.name === 'default') {
      varName = file.exports.default;
      if (varName == null) {
        ctx.warnings.push(`${fromFile.rel}:${line}: ${file.rel} has no default export`);
        return null;
      }
    } else if (curImp.name === 'namespace') {
      ctx.warnings.push(`${fromFile.rel}:${line}: namespace import "${curImp.source}" mounted without member access; skipped`);
      return null;
    } else {
      varName = file.exports.named.get(curImp.name);
      if (varName == null) {
        ctx.warnings.push(`${fromFile.rel}:${line}: ${file.rel} has no export "${curImp.name}"`);
        return null;
      }
    }

    if (typeof varName === 'string') {
      if (file.routers.has(varName) || file.apps.has(varName)) return { file, varName, kind: 'router' };
      if (file.routerFactories.has(varName)) return { file, varName, kind: 'factory' };
      if (file.functions.has(varName)) return { file, varName, kind: 'function' };
      const chained = file.imports.get(varName);
      if (chained) {
        curFile = file;
        curImp = { source: chained.source, name: chained.name, member: chained.member };
        continue;
      }
      ctx.warnings.push(`${file.rel}: export "${varName}" was not recognized as express.Router(); mounting anyway`);
      return { file, varName, kind: 'router' };
    }
    if (varName && varName.reexport) {
      curFile = file;
      curImp = { source: varName.reexport, name: varName.name || 'default', member: curImp.member };
      continue;
    }
    ctx.warnings.push(`${fromFile.rel}:${line}: mounted export in ${file.rel} is not a router variable; skipped`);
    return null;
  }
}

function scopedEvents(file, info) {
  if (!info || typeof info.start !== 'number' || typeof info.end !== 'number') return file.events;
  return file.events.filter((ev) => ev.start >= info.start && ev.start <= info.end);
}

// Mounts a target; returns true when mounted or when the arg was reclassified
// as named middleware (recorded into mwNames), false when nothing happened.
function mountTarget(target, subPrefix, passDown, stack, ctx, depth, fromFile, line, rawArg, mwNames) {
  if (target.localFactory) {
    const info = fromFile.routerFactories.get(target.localFactory);
    if (!info) return false;
    emitTree(fromFile, info.var, subPrefix, passDown, stack, ctx, depth, scopedEvents(fromFile, info), `@f${info.start}`);
    return true;
  }
  if (target.local) {
    emitTree(fromFile, target.local, subPrefix, passDown, stack, ctx, depth);
    if (!fromFile.routers.has(target.local) && !fromFile.apps.has(target.local) && !fromFile.routerFactories.has(target.local)) {
      ctx.warnings.push(`${fromFile.rel}:${line}: "${target.local}" was not recognized as express.Router(); mounting anyway`);
    }
    return true;
  }
  if (target.import) {
    const resolved = resolveTargetFile(fromFile, target.import, ctx, line);
    if (!resolved) return false;
    if (resolved.kind === 'function') {
      const nm = exprName(rawArg); // imported plain function = middleware, not a mount
      if (nm && mwNames) mwNames.push(nm);
      return true;
    }
    if (resolved.kind === 'factory') {
      const info = resolved.file.routerFactories.get(resolved.varName);
      if (info) {
        emitTree(resolved.file, info.var, subPrefix, passDown, stack, ctx, depth, scopedEvents(resolved.file, info), `@f${info.start}`);
        return true;
      }
    }
    emitTree(resolved.file, resolved.varName, subPrefix, passDown, stack, ctx, depth);
    return true;
  }
  return false;
}

function emitTree(file, varName, prefix, initGuards, stack, ctx, depth, events = file.events, keySuffix = '') {
  const key = `${file.abs}#${varName}${keySuffix}`;
  if (stack.has(key)) {
    ctx.warnings.push(`${file.rel}: circular mount involving "${varName}"; sub-tree skipped`);
    return;
  }
  if (depth > MAX_DEPTH) return;
  stack.add(key);
  ctx.reached.add(key);
  ctx.reached.add(`${file.abs}#${varName}`); // plain key: factory-scoped trees satisfy never-mounted checks

  const guards = initGuards.map((g) => ({ prefix: g.prefix, names: g.names.slice() }));

  for (const ev of events) {
    if (ev.obj !== varName) continue;

    if (ev.kind === 'route') {
      if (!ROUTE_METHODS.has(ev.method)) {
        ctx.warnings.push(`${file.rel}:${ev.line}: ${ev.obj || 'router'}.${ev.method}() has no single method; skipped`);
        continue;
      }
      const p = ev.pathOverride !== undefined ? ev.pathOverride : staticPathValue(ev.argNodes.length ? ev.argNodes[0] : null);
      if (p === undefined) {
        ctx.warnings.push(`${file.rel}:${ev.line}: non-static route path on ${ev.obj || 'router'}.${ev.method}(); skipped`);
        continue;
      }
      const fullPath = joinPath(prefix, p);
      const inherited = [];
      for (const g of guards) if (prefixMatches(fullPath, g.prefix)) inherited.push(...g.names);
      ctx.routes.push({
        method: ev.method,
        path: fullPath,
        file: file.rel,
        line: ev.line,
        middlewares: [...inherited, ...ev.mwNames],
        hasGuard: false,
      });
      continue;
    }

    // kind === 'use': split args into (optional) mount path, router mounts, middleware guards.
    const args = ev.argNodes || [];
    let i = 0;
    let mountPath = '';
    const firstPath = staticPathValue(args.length ? args[0] : null);
    if (firstPath !== undefined) {
      mountPath = firstPath;
      i = 1;
    }
    const mwNames = [];
    for (; i < args.length; i++) {
      const arg = args[i];
      const target = classifyTarget(file, arg);
      if (target) {
        const passDown = guards
          .filter((g) => prefixMatches(mountPath, g.prefix))
          .map((g) => ({ prefix: '', names: g.names.slice() }));
        if (mwNames.length) passDown.push({ prefix: '', names: mwNames.slice() });
        const mounted = mountTarget(target, joinPath(prefix, mountPath), passDown, stack, ctx, depth + 1, file, ev.line, arg, mwNames);
        if (!mounted) {
          const names = mwNameOf(arg);
          if (names) mwNames.push(...names);
        }
      } else {
        // Unnamed inline middleware is silently tolerated (can't be named statically).
        const names = mwNameOf(arg);
        if (names) mwNames.push(...names);
      }
    }
    if (mwNames.length) guards.push({ prefix: mountPath, names: mwNames.slice() });
  }

  stack.delete(key);
}

/* ---------- public API ---------- */

/**
 * Extract the Express route table of a project, statically.
 * Returns { routes: [{ method, path, file, line, middlewares, hasGuard }],
 *           publicRoutes: string[], warnings: string[] } — never throws.
 */
export async function extractRoutes(projectDir, options = {}) {
  const warnings = [];
  const routes = [];
  const publicRoutes = [];
  const unsupportedFrameworks = [];
  const ineffectiveGuards = [];
  try {
    const rootDir = path.resolve(String(projectDir ?? '.'));
    if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
      warnings.push(`project directory not found: ${rootDir}`);
      return { routes, publicRoutes, warnings };
    }

    const cfgFile = options.configPath ? path.resolve(rootDir, String(options.configPath)) : path.join(rootDir, 'finalcheck.config.json');
    if (existsSync(cfgFile)) {
      try {
        const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
        if (Array.isArray(cfg && cfg.publicRoutes)) publicRoutes.push(...cfg.publicRoutes.filter((x) => typeof x === 'string'));
        else warnings.push('finalcheck.config.json: publicRoutes is not an array; ignored');
      } catch (e) {
        warnings.push(`finalcheck.config.json: cannot parse (${e.message})`);
      }
    }

    const ctx = { rootDir, warnings, routes, cache: new Map(), reached: new Set() };
    const analyses = [];
    for (const abs of collectFiles(rootDir)) {
      const text = readFileSync(abs, 'utf8');
      if (/fastify|@koa\/router|@hapi\/hapi|next\/server|\bkoa\b|\bhono\b/.test(text)) {
        const model = sourceModel(text);
        if (model) walkSource(model.ast, (node) => {
          const pkg = node.type === 'ImportDeclaration' ? node.source?.value
            : node.type === 'CallExpression' && node.callee?.name === 'require' ? node.arguments[0]?.value : null;
          if (typeof pkg === 'string' && /^(?:fastify|koa|@koa\/router|@hapi\/hapi|next\/server|hono)(?:\/|$)/.test(pkg)) {
            unsupportedFrameworks.push(`${path.relative(rootDir, abs).replace(/\\/g, '/')}: ${pkg}`);
          }
        });
      }
      const a = analyzeCached(abs, ctx);
      if (a) {
        analyses.push(a);
        const model = sourceModel(text);
        if (model) walkSource(model.ast, (node) => {
          const name = node.type === 'FunctionDeclaration' ? node.id?.name : node.type === 'VariableDeclarator' ? node.id?.name : null;
          const fn = node.type === 'VariableDeclarator' ? model.resolve(node.init) : node;
          if (!name || !GUARD_RE.test(name) || !isFunction(fn)) return;
          const next = fn.params[2]?.name;
          const statement = fn.body?.type === 'BlockStatement' && fn.body.body.length === 1 ? fn.body.body[0] : null;
          const body = statement?.type === 'ReturnStatement' ? statement.argument : statement?.type === 'ExpressionStatement' ? statement.expression : fn.body;
          if (next && body?.type === 'CallExpression' && body.callee?.name === next && body.arguments.length === 0) {
            ineffectiveGuards.push({ file: a.rel, name });
          }
        });
      }
    }

    // Roots: express() apps not mounted locally in their own file (sub-apps are reached via mounts).
    const roots = [];
    for (const a of analyses) {
      const mountedLocally = new Set();
      for (const ev of a.events) {
        if (ev.kind !== 'use') continue;
        for (const arg of ev.argNodes || []) {
          const t = classifyTarget(a, arg);
          if (t && (t.local || t.localFactory)) mountedLocally.add(t.local || t.localFactory);
        }
      }
      for (const name of [...a.apps].sort()) {
        if (!mountedLocally.has(name)) roots.push({ file: a, name });
      }
    }

    if (roots.length) {
      for (const r of roots) emitTree(r.file, r.name, '', [], new Set(), ctx, 0);
      for (const a of analyses) {
        for (const name of [...a.routers].sort()) {
          if (!ctx.reached.has(`${a.abs}#${name}`)) {
            ctx.warnings.push(`${a.rel}: router "${name}" is never mounted; its routes are not included`);
          }
        }
      }
    } else {
      // Fail open: no express() app found — emit each file's unmounted routers as roots.
      let emitted = false;
      for (const a of analyses) {
        const targeted = new Set();
        for (const ev of a.events) {
          if (ev.kind !== 'use') continue;
          for (const arg of ev.argNodes || []) {
            const t = classifyTarget(a, arg);
            if (t && (t.local || t.localFactory)) targeted.add(t.local || t.localFactory);
          }
        }
        let names = [...a.routers].filter((n) => !targeted.has(n)).sort();
        if (!names.length && a.routers.size) names = [[...a.routers].sort()[0]];
        for (const n of names) {
          if (ctx.reached.has(`${a.abs}#${n}`)) continue;
          emitTree(a, n, '', [], new Set(), ctx, 0);
          emitted = true;
        }
      }
      if (emitted) ctx.warnings.push('no express() app entry found; emitted router routes without mount prefixes');
    }

    // Guard verdict: auth-ish middleware anywhere in the chain, or an explicit
    // publicRoutes whitelist hit (S1 exemption, spec'd to count as guarded).
    for (const r of routes) {
      r.hasGuard = r.middlewares.some((m) => GUARD_RE.test(m) && !ineffectiveGuards.some((guard) => guard.file === r.file && guard.name === m)) || isPublicPath(r.path, publicRoutes);
    }
    routes.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : 1)));
  } catch (e) {
    warnings.push(`extractRoutes failed unexpectedly: ${e && e.message ? e.message : e}`);
  }
  return { routes, publicRoutes, warnings, ...(unsupportedFrameworks.length ? { unsupportedFrameworks } : {}), ...(ineffectiveGuards.length ? { ineffectiveGuards } : {}) };
}

function collectFiles(rootDir) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) visit(p);
      } else if (SCANNED_EXTS.has(path.extname(ent.name).toLowerCase())) {
        out.push(p);
      }
    }
  };
  visit(rootDir);
  return out;
}
