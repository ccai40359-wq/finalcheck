// S1 鉴权覆盖：吃路由提取器输出，逐接口判守卫。白名单=publicRoutes
// 常见天然公开接口：命中则给白名单引导，降噪（2026-11-07 某真实项目实测 91 条里一大半是这类）
import { isPublicPath } from '../route-path.mjs';

const PUBLIC_HINT = /(login|logout|register|signup|auth\/|ping|health|status|version|metrics|docs|openapi)/i;

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
  'authorization', 'authorize', 'authorized',
  'jwt', 'passport', 'token', 'guard', 'protect', 'protected',
  'login', 'signin', 'loggedin',
]);
// 全小写连写的常见守卫名（camelCase 切不开时兜底，例如 `requireauth`）。
const GUARD_COMPOUNDS = new Set([
  'authguard', 'sessionauth', 'sessionauthmiddleware', 'authmiddleware',
  'loggedin', 'ensureloggedin', 'isloggedin', 'isauthenticated',
  'requireauth', 'requirelogin', 'loginrequired', 'checkauth', 'checktoken',
  'verifytoken', 'authenticate', 'authorize', 'passportauthenticate',
  'jwtauth', 'jwtmiddleware', 'authrequired', 'authnrequired',
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
  // `require('./auth')` / `passport.authenticate('jwt')` 直接按整串切 token；
  // 去掉调用参数里的引号不影响 token 边界。
  const tokens = tokenize(raw);
  if (!tokens.length) return false;
  // 容器/路由表类名字先否决：authRoutes、sessionStore、loginLimiter、authController
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
function routeHasGuard(route, publicRoutes) {
  if (Array.isArray(route.middlewares)) {
    return route.middlewares.some((m) => isGuardName(m));
  }
  return Boolean(route.hasGuard) || publicHit(route.path, publicRoutes);
}

export async function checkAuthCoverage(routeResult) {
  const findings = [];
  const routes = Array.isArray(routeResult && routeResult.routes) ? routeResult.routes : [];
  // 空路由表 = 没有可分析的 HTTP 接口。但「没有 HTTP」不等于「没查」：
  // 桌面应用没有 HTTP 路由，S1（只覆盖 HTTP 鉴权）属结构性不适用，不封顶结论；
  // 本地 IPC 权限面由 S7 检查。gapKind=not-applicable 由结论引擎过滤，不再算「无法验收」。
  if (!routes.length) {
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
    if (!routeHasGuard(r, publicRoutes)) {
      const hint = PUBLIC_HINT.test(r.path) ? '（常见公开接口：确认后登记进 finalcheck.config.json 的 publicRoutes 即可消除）' : '';
      findings.push({ checkId: 'S1', severity: 'high', force: 'card', file: r.file, line: r.line, rule: 'S1.no-guard', snippet: `${r.method.toUpperCase()} ${r.path}`, message: `接口无登录守卫${hint}`, source: 'program' });
    }
  }
  return { checkId: 'S1', findings, coverageGap: routeResult.warnings?.length ? `路由提取警告 ${routeResult.warnings.length} 条` : null };
}
