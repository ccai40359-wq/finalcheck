// 仓库形态识别（round5 定案）：库/框架仓（fastapi/flask/requests/gin）没有产品 HTTP 面，
// 它们代码里的路由全是文档示例与框架内部实现，不该按"产品接口无鉴权"硬卡。
// 判据：根目录有「可安装包 manifest」（pyproject/setup.py/go.mod/Cargo.toml）或
// 「无 start 脚本的 package.json」，且没有任何部署/服务信号（Dockerfile/compose/k8s/
// start 脚本/服务端依赖/spring-boot-web/manage.py/config.routes.rb/web 框架 requirements）。
// 服务信号优先：只要有任何一个，就按服务仓处理（S1 照常硬卡）。
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { listTextFiles } from './walk.mjs';
import { isNonProductPath } from './scope-policy.mjs';

const DEPLOY_ROOT_FILE_RE = /^(?:Dockerfile|docker-compose(?:[.-][\w-]+)?\.ya?ml|Procfile|fly\.toml|vercel\.json|netlify\.toml|render\.yaml|app\.yaml|compose\.ya?ml)$/i;
const LIB_MANIFEST_RE = /^(?:pyproject\.toml|setup\.py|setup\.cfg|go\.mod|Cargo\.toml)$/i;
const DEPLOY_DIR_RE = /^(?:k8s|kubernetes|deploy|charts|helm)$/i;
const SERVER_DEPS = ['express', 'fastify', 'koa', 'hono', '@nestjs/core', 'next', 'socket.io', '@trpc/server'];
const PY_WEB_FRAMEWORK_RE = /\b(?:flask|django|fastapi|uvicorn|gunicorn)\b/i;

export async function isLibraryRepo(projectDir, { excludes = [], includeFixtures = false } = {}) {
  let rootEntries;
  try {
    rootEntries = await readdir(projectDir, { withFileTypes: true });
  } catch {
    return false;
  }
  const rootNames = rootEntries.map((e) => e.name);
  const hasDeploy = rootNames.some((n) => DEPLOY_ROOT_FILE_RE.test(n) || DEPLOY_DIR_RE.test(n));

  let pkg = null;
  const hasPkg = rootNames.includes('package.json');
  if (hasPkg) {
    try { pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8')); } catch { pkg = null; }
  }
  const hasStart = typeof pkg?.scripts?.start === 'string' && pkg.scripts.start.trim();
  const rootDeps = { ...(pkg?.dependencies || {}), ...(pkg?.peerDependencies || {}) };
  const hasServerDep = SERVER_DEPS.some((k) => rootDeps[k]);

  // 服务信号一：部署产物 / start 脚本 / 服务端依赖
  if (hasDeploy || hasStart || hasServerDep) return false;
  // 服务信号二：Django（manage.py + settings.py）
  if (rootNames.includes('manage.py') && rootNames.some((n) => /settings\.py$/i.test(n))) return false;
  // 服务信号三：Rails（config/routes.rb）
  if (rootNames.includes('routes.rb') || rootNames.some((n) => n.toLowerCase() === 'routes.rb')) return false;

  // 文件级信号（走统一 walk 口径，跳过非产品路径）
  let files = null;
  try {
    ({ files } = await listTextFiles(projectDir, excludes, { includeFixtures }));
  } catch {
    files = [];
  }
  const relFiles = files.map((f) => path.relative(projectDir, f).replace(/\\/g, '/')).filter((f) => !isNonProductPath(f));
  const findFile = (re) => relFiles.find((f) => re.test(f));

  // 服务信号四：pom.xml 带 spring-boot-starter-web
  const pom = findFile(/pom\.xml$/i);
  if (pom) {
    const t = await readFile(path.join(projectDir, pom), 'utf8').catch(() => '');
    if (/spring-boot-starter-(?:web|actuator)/i.test(t)) return false;
  }
  // 服务信号五：config/routes.rb（深层路径）
  if (findFile(/config\/routes\.rb$/i)) return false;
  // 服务信号六：Python 入口/main 带 web 框架，或 requirements 带 web 框架
  const pyEntry = findFile(/(?:^|\/)(?:main|app|server|run|wsgi|asgi)\.py$/i);
  if (pyEntry && PY_WEB_FRAMEWORK_RE.test(await readFile(path.join(projectDir, pyEntry), 'utf8').catch(() => ''))) return false;
  const req = findFile(/requirements(?:-[\w.]+)?\.txt$/i);
  if (req && PY_WEB_FRAMEWORK_RE.test(await readFile(path.join(projectDir, req), 'utf8').catch(() => ''))) return false;

  // 库 manifest：pyproject/setup.py/go.mod/Cargo.toml 在根，或 package.json 无 start
  const hasLibManifest = rootNames.some((n) => LIB_MANIFEST_RE.test(n));
  if (hasLibManifest) return true;
  if (hasPkg && !hasStart) return true;
  return false;
}
