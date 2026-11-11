// Express 路由路径纯函数（从 extract-routes.mjs 抽出）：无 IO、无 AST 遍历，便于单独测试。

export function staticPathValue(n) {
  if (!n) return undefined;
  if (n.type === 'StringLiteral') return n.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) {
    return n.quasis[0].value.cooked ?? n.quasis[0].value.raw;
  }
  return undefined;
}

export function joinPath(prefix, sub) {
  let base = prefix || '';
  let rest = sub || '';
  if (!rest || rest === '/') return base || '/';
  if (!rest.startsWith('/')) rest = '/' + rest;
  base = base.replace(/\/+$/, '');
  if (!base || base === '/') return rest;
  return base + rest;
}

// Express use-guard scope: guard on '/api' covers '/api' and '/api/...'.
export function prefixMatches(routePath, guardPrefix) {
  if (!guardPrefix || guardPrefix === '/') return true;
  if (routePath === guardPrefix) return true;
  return routePath.startsWith(guardPrefix.endsWith('/') ? guardPrefix : guardPrefix + '/');
}

export function isPublicPath(routePath, publicRoutes) {
  return publicRoutes.some((entry) => {
    if (entry === '*' || entry === '/*') return true;
    if (entry === routePath) return true;
    if (entry.endsWith('/*')) {
      const base = entry.slice(0, -2);
      return routePath === base || routePath.startsWith(base + '/');
    }
    if (entry.endsWith('*')) return routePath.startsWith(entry.slice(0, -1));
    return routePath.startsWith(entry + '/');
  });
}

export function isRelativeSource(source) {
  return typeof source === 'string' &&
    (source.startsWith('./') || source.startsWith('../') || source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source));
}
