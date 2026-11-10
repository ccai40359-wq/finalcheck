import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listTextFiles, readRel } from './walk.mjs';

const AUTH_DEPS = /passport|jsonwebtoken|express-session|bcrypt|argon2|next-auth|firebase|clerk|auth0|jose/i;
const PAY_DEPS = /stripe|paypal|braintree|alipay|wxpay|wechatpay|payment|checkout/i;

// ACCEPTANCE §2: 先自动猜档，信号命中越多档越高
export async function detectTier(projectDir, { excludes = [] } = {}) {
  const signals = [];
  let tier = 'L1';
  try {
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const auth = deps.filter((n) => AUTH_DEPS.test(n));
    const pay = deps.filter((n) => PAY_DEPS.test(n));
    if (auth.length) { signals.push(`鉴权/会话依赖：${auth.join(', ')}`); if (tier === 'L1') tier = 'L2'; }
    if (pay.length) { signals.push(`支付依赖：${pay.join(', ')}`); tier = 'L3'; }
  } catch { signals.push('未找到 package.json'); }

  const { files } = await listTextFiles(projectDir, excludes);
  let authSeen = false, deploySeen = false, bindAllSeen = false;
  for (const f of files.slice(0, 400)) {
    const { file, text } = await readRel(projectDir, f);
    if (/\.env/i.test(file)) continue;
    if (/\.(md|txt)$/i.test(file)) continue; // 自食教训：文档描述规则 ≠ 代码真有鉴权
    // 自食教训：扫描器源码含正则字面量会被裸词匹配自咬 → 只认调用形态
    if (/passport\.authenticate\s*\(|from\s+['"]jsonwebtoken['"]|require\(\s*['"]jsonwebtoken['"]\s*\)|app\.use\([^)]*express-session[^)]*\)/i.test(text)) authSeen = true;
    if (/Dockerfile|docker-compose|deploy/i.test(file)) deploySeen = true;
    if (/listen\([^)]*['"]0\.0\.0\.0['"]|host:\s*['"]0\.0\.0\.0['"]/.test(text)) bindAllSeen = true;
  }
  if (authSeen) { signals.push('源码出现鉴权/会话用法'); if (tier === 'L1') tier = 'L2'; }
  if (deploySeen && bindAllSeen) { signals.push('部署配置且绑定 0.0.0.0'); if (tier === 'L1') tier = 'L2'; }
  return { suggestedTier: tier, signals };
}
