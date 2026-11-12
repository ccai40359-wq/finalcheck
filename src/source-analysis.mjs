// Shared syntax/context helpers. These resolve local syntax, not interprocedural
// authorization or an execution proof; callers retain unknown/manual states.
import { parse } from '@babel/parser';

export function walkSource(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, parent) === false) return;
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'comments', 'tokens', 'leadingComments', 'trailingComments', 'innerComments', 'extra'].includes(key)) continue;
    if (Array.isArray(value)) for (const child of value) walkSource(child, visit, node);
    else if (value && typeof value === 'object') walkSource(value, visit, node);
  }
}

export const memberName = (node) => node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression'
  ? (node.computed ? node.property?.value : node.property?.name) : null;
export const isFunction = (node) => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node?.type);

export function sourceModel(text) {
  let ast;
  try { ast = parse(text, { sourceType: 'unambiguous', plugins: ['jsx', 'typescript'], errorRecovery: true, allowReturnOutsideFunction: true }); }
  catch { return null; }
  if (ast.errors?.length) return null;
  const parents = new WeakMap();
  const declarations = new Map();
  const isScope = (n) => n?.type === 'Program' || n?.type === 'BlockStatement' || isFunction(n);
  const scopeOf = (node) => { let n = parents.get(node); while (n && !isScope(n)) n = parents.get(n); return n; };
  walkSource(ast, (node, parent) => {
    if (parent) parents.set(node, parent);
    let name, value;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') { name = node.id.name; value = node.init; }
    if (node.type === 'FunctionDeclaration' && node.id) { name = node.id.name; value = node; }
    if (name) {
      const scope = scopeOf(node);
      if (!declarations.has(scope)) declarations.set(scope, new Map());
      declarations.get(scope).set(name, value);
    }
  });
  const invalidBindings = new Set();
  const binding = (node) => {
    let scope = scopeOf(node);
    while (scope) {
      if (declarations.get(scope)?.has(node.name)) {
        const value = declarations.get(scope).get(node.name);
        return invalidBindings.has(value) ? null : value;
      }
      if (isFunction(scope) && scope.params.some((p) => p.type === 'Identifier' && p.name === node.name)) return null;
      scope = scopeOf(scope);
    }
    return null;
  };
  // A changed variable/object is no longer a static constant. Do not reuse its
  // original safe options after reassignment or a property write.
  walkSource(ast, (node) => {
    let target = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' ? node.argument : null;
    while (target?.type === 'MemberExpression') target = target.object;
    if (target?.type === 'Identifier') {
      const value = binding(target);
      if (value) invalidBindings.add(value);
    }
  });
  const resolve = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return null;
    if (node.type !== 'Identifier') return node;
    seen.add(node);
    return resolve(binding(node), seen);
  };
  const chars = text.split('');
  for (const comment of ast.comments || []) for (let i = comment.start; i < comment.end; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  const code = chars.join('');
  return { ast, code, parents, binding, resolve, text: (node) => code.slice(node?.start ?? 0, node?.end ?? 0) };
}

export function routeHandlers(model, route) {
  if (!model) return { nodes: [], resolved: false };
  const nodes = [];
  let matched = false;
  const add = (raw) => {
    const node = model.resolve(raw);
    if (!node) return;
    if (node.type === 'ArrayExpression') { for (const item of node.elements) add(item); return; }
    if (isFunction(node) || node.type === 'CallExpression') nodes.push(node);
  };
  walkSource(model.ast, (node) => {
    if (node.type !== 'CallExpression' || memberName(node.callee) !== route.method || node.loc?.start.line !== route.line) return;
    matched = true;
    const first = node.arguments[0];
    const args = first?.type === 'StringLiteral' || first?.type === 'TemplateLiteral' ? node.arguments.slice(1) : node.arguments;
    for (const arg of args) add(arg);
  });
  return { nodes, resolved: matched && nodes.length > 0 };
}

export function someCall(nodes, predicate) {
  let found = false;
  for (const root of nodes) walkSource(root, (node) => {
    if (node.type === 'CallExpression' && predicate(node)) found = true;
  });
  return found;
}

export function staticValue(model, raw, seen = new Set()) {
  const node = model?.resolve(raw) || raw;
  if (!node || seen.has(node)) return undefined;
  seen.add(node);
  if (['StringLiteral', 'BooleanLiteral', 'NumericLiteral'].includes(node.type)) return node.value;
  if (node.type === 'ObjectExpression') {
    const value = {};
    for (const prop of node.properties) {
      if (prop.type !== 'ObjectProperty' || prop.computed) return undefined;
      const key = prop.key.name ?? prop.key.value;
      value[key] = staticValue(model, prop.value, new Set(seen));
    }
    return value;
  }
  return undefined;
}
