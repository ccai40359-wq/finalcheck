// S1 鉴权覆盖：吃路由提取器输出，逐接口判守卫。白名单=publicRoutes
// 常见天然公开接口：命中则给白名单引导，降噪（2026-11-07 某真实项目实测 91 条里一大半是这类）
import { isPublicPath } from '../route-path.mjs';

// 常见天然公开接口按「路径段」精确匹配，避免 /docs-internal、/healthcheck-admin
// 这类同前缀的敏感路径被误降噪。
const PUBLIC_SEGMENTS = new Set([
  'health', 'healthz', 'ready', 'readiness', 'live', 'liveness',
  'ping', 'status', 'version', 'metrics', 'docs', 'openapi', 'swagger', 'api-docs',
  'login', 'logout', 'register', 'signup',
  'well-known', 'security.txt',
]);

function isCommonPublicPath(routePath) {
  const segs = String(routePath || '').toLowerCase().split('/').filter(Boolean);
  if (segs.some((s) => PUBLIC_SEGMENTS.has(s))) return true;
  // `auth/...` 前缀（/auth/login、/api/auth/token 等）
  return segs.some((s, i) => s === 'auth' && i < segs.length - 1);
}

// 文档/接口说明包里的路由（Flowise packages/api-documentation 的 GET /）
// 本身就是公开文档面，不按产品鉴权面硬卡。
function isDocsSurfaceFile(file) {
  return /(?:^|\/)(?:api-documentation|api-docs|swagger|openapi|docs?)\//i.test(String(file || ''));
}

// MCP 参考/传输服务器的 /sse、/message、/mcp 是协议传输端点，不是产品鉴权面；
// 按文件路径 + 精确端点匹配，避免把普通 /message 产品接口一起降噪。
function isMcpTransportEndpoint(routePath, file) {
  const p = String(routePath || '').toLowerCase();
  if (!/^(?:\/sse|\/message|\/mcp)(?:\/|$)/.test(p)) return false;
  return /(?:^|\/)(?:everything|transport|transports|mcp)(?:\/|\.)/i.test(String(file || ''));
}

// ---------------------------------------------------------------------------
// 守卫名识别（S1 假通过治理）
//
// 旧实现是裸子串 /(auth|jwt|passport|session|...)/i：`author`、`sessionStore`、
// `loginLimiter`、`authRoutes` 都会被当成守卫，接口没鉴权却判「过」。
// 这里改为标识符分段 + 词边界判定：
//   1) 按非字母数字、camelCase、acronym 边界切成 token（`passport.authenticate('jwt')`
//      / `require('./auth')` 这类字符串表达式也能切）；
//   2) token 里出现明确的守卫词（auth/authenticate/jwt/guard/login...）才算命中；
//   3) 出现 routes/store/limiter/controller 等「容器/路由表」token 时一律否决
//      （authRoutes、sessionStore、loginLimiter 不是守卫）；
//   4) session 单独出现不算（sessionStore），只有 sessionAuth/sessionGuard/
//      sessionMiddleware 这类带守卫语义的组合才算。
// 纯函数、无 IO，导出便于单测。
// ---------------------------------------------------------------------------

const GUARD_TOKENS = new Set([
  'auth', 'authn', 'authz', 'authguard',
  'authentication', 'authenticate', 'authenticated',
  'authorize', 'authorized',
  'jwt', 'passport', 'protect', 'protected',
  'login', 'signin', 'loggedin',
]);
// 全小写连写的常见守卫名（camelCase 切不开时兜底，例如 `requireauth`）。
const GUARD_COMPOUNDS = new Set([
  'authguard', 'sessionauth', 'sessionauthmiddleware', 'authmiddleware',
  'loggedin', 'ensureloggedin', 'isloggedin', 'isauthenticated',
  'requireauth', 'requirelogin', 'loginrequired', 'checkauth', 'checktoken',
  'verifytoken', 'authenticate', 'authorize', 'passportauthenticate',
  'jwtauth', 'jwtmiddleware', 'authrequired', 'authnrequired',
  // juice-shop 的 security.appendUserId()：JWT 校验并 401，是登录守卫
  'appenduserid',
]);
// 这些 token 说明名字描述的是路由表 / 存储 / 限流器等载体，而不是一个守卫。
const CONTAINER_TOKENS = new Set([
  'routes', 'route', 'router',
  'store', 'storage', 'limiter', 'rate', 'controller', 'service', 'services',
  'repository', 'repo', 'model', 'models', 'config', 'configs', 'client',
  'provider', 'factory', 'plugin', 'plugins',
  'util', 'utils', 'helper', 'helpers', 'type', 'types', 'schema', 'schemas',
  'dto', 'constant', 'constants',
  'page', 'pages', 'view', 'views', 'component', 'components',
  'api', 'apis', 'endpoint', 'endpoints',
  'test', 'tests', 'spec', 'specs', 'mock', 'mocks', 'fixture', 'fixtures',
]);
// session 只有跟这些「守卫语义」token 组合时才命中（sessionStore/sessionLimiter 不命中）。
const SESSION_COMPANIONS = new Set([
  'auth', 'authn', 'authz', 'authentication', 'authenticate', 'authenticated',
  'authorization', 'authorize', 'authorized',
  'guard', 'protect', 'protected', 'middleware', 'mw',
  'required', 'require', 'check', 'verify', 'checker', 'validator',
]);

function tokenize(name) {
  const parts = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const tokens = [];
  for (const part of parts) {
    // camelCase / acronym 边界：requireAuth、JWTGuard、session_store 都能切开
    const sub = part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    for (const s of sub) {
      const t = s.toLowerCase();
      if (t) tokens.push(t);
    }
  }
  return tokens;
}

/**
 * 判断一个中间件名/表达式是否真的是登录/鉴权守卫（词边界识别，非裸子串）。
 * @param {unknown} name
 * @returns {boolean}
 */
export function isGuardName(name) {
  if (typeof name !== 'string') return false;
  const raw = name.trim();
  if (!raw) return false;
  // Member expressions judge only the last member segment:
  // routes.isLoggedIn / router.authMiddleware / passport.authenticate('jwt')
  // are guards, while routes.authRoutes / router.author are not.
  // A dot inside a module path (`require('./auth')`) leaves the last segment
  // as `/auth')`, whose auth token still identifies a guard.
  const segment = raw.includes('.') ? raw.slice(raw.lastIndexOf('.') + 1) : raw;
  const callIdx = segment.indexOf('(');
  const head = callIdx >= 0 ? segment.slice(0, callIdx) : segment;
  const tokens = tokenize(head);
  if (!tokens.length) return false;
  // 容器/路由表类 token 只否决它所在的那一段：authRoutes 不是守卫，
  // 但 routes.isLoggedIn 的 routes 段不影响 isLoggedIn。
  if (tokens.some((t) => CONTAINER_TOKENS.has(t))) return false;
  const joined = tokens.join('');
  if (GUARD_COMPOUNDS.has(joined)) return true;
  // `ensureLoggedIn` / `isLoggedIn` 会被切成 logged + in
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'logged' && tokens[i + 1] === 'in') return true;
    if (GUARD_TOKENS.has(tokens[i])) return true;
  }
  // session：只有 sessionAuth / sessionGuard / sessionMiddleware 这类组合才算
  if (tokens.includes('session') && tokens.some((t) => SESSION_COMPANIONS.has(t))) return true;
  return false;
}

function publicHit(routePath, publicRoutes) {
  return publicRoutes.includes(routePath) || isPublicPath(routePath, publicRoutes);
}

// hasGuard 由 extract-routes 用旧裸子串算出来，可能是假阳性。
// 有 middlewares 数组时以 isGuardName 重新判定；老调用方只给 hasGuard 布尔值时保留原语义。
function routeHasGuard(route, publicRoutes, ineffectiveGuards = []) {
  if (route.hasInternalGuard) return true; // handler/factory 内部已校验登录
  if (Array.isArray(route.middlewares)) {
    return route.middlewares.some((m) => isGuardName(m) && !ineffectiveGuards.some((guard) => guard.file === route.file && guard.name === m));
  }
  return Boolean(route.hasGuard) || publicHit(route.path, publicRoutes);
}

export async function checkAuthCoverage(routeResult) {
  const findings = [];
  const routes = Array.isArray(routeResult && routeResult.routes) ? routeResult.routes : [];
  const unsupportedGap = routeResult?.unsupportedFrameworks?.length
    ? `HTTP 框架尚未支持：${routeResult.unsupportedFrameworks.join('；')}（目前仅支持 Express 路由）` : null;
  // 空路由表但有 HTTP 服务/路由注册信号 → 提取器没解析出来，S1 未覆盖（unavailable）。
  // 只有完全没有 HTTP 信号时才是结构性的 not-applicable（本地 IPC 权限面由 S7 检查）。
  const httpSignal = Boolean(unsupportedGap) || Boolean(routeResult?.httpSurface?.exists);
  if (!routes.length) {
    if (httpSignal) {
      const hint = unsupportedGap
        ? `框架：${routeResult.unsupportedFrameworks.join('；')}`
        : '检测到自定义 HTTP server / 路由挂载调用';
      return {
        checkId: 'S1',
        findings,
        coverageGap: `检测到 HTTP 服务/路由注册，但路由提取器未解析出路由表，S1 未覆盖（${hint}）`,
        gapKind: 'unavailable',
      };
    }
    return {
      checkId: 'S1',
      findings,
      coverageGap: '未发现 HTTP 路由（路由表为空），S1 鉴权覆盖不适用（本地 IPC 权限面由 S7 检查）',
      gapKind: 'not-applicable',
    };
  }
  const publicRoutes = routeResult.publicRoutes || [];
  for (const r of routes) {
    if (r.method === 'use') continue; // 装配路径不是独立接口
    if (publicHit(r.path, publicRoutes)) continue;
    if (!routeHasGuard(r, publicRoutes, routeResult.ineffectiveGuards || [])) {
      // 常见公开接口（健康检查/文档/登录入口）仍报，但降为 medium/check 并提示
      // 登记 publicRoutes；/docs-internal、/healthcheck-admin 等不会按段误命中。
      if (isCommonPublicPath(r.path) || isDocsSurfaceFile(r.file) || isMcpTransportEndpoint(r.path, r.file)) {
        findings.push({
          checkId: 'S1',
          severity: 'medium',
          force: 'check',
          file: r.file,
          line: r.line,
          rule: 'S1.no-guard',
          snippet: `${r.method.toUpperCase()} ${r.path}`,
          message: '接口无登录守卫；常见公开接口，确认后登记 publicRoutes（若并非公开接口，请补登录守卫）',
          source: 'program',
        });
      } else {
        findings.push({
          checkId: 'S1',
          severity: 'high',
          force: 'card',
          file: r.file,
          line: r.line,
          rule: 'S1.no-guard',
          snippet: `${r.method.toUpperCase()} ${r.path}`,
          message: '接口无登录守卫',
          source: 'program',
        });
      }
    }
  }
  return { checkId: 'S1', findings, coverageGap: unsupportedGap || (routeResult.warnings?.length ? `路由提取警告 ${routeResult.warnings.length} 条` : null) };
}
