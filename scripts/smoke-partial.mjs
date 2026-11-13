// 部分冒烟：不依赖路由提取器的模块先跑起来（tiers/S3/S5）
import { fileURLToPath } from 'node:url';
import { detectTier } from '../src/tiers.mjs';
import { checkSecrets } from '../src/checks/secrets.mjs';
import { checkConfig } from '../src/checks/config.mjs';

// fileURLToPath 而不是 .pathname：路径含空格时 .pathname 会保留 %20，审计会指向不存在的目录
const dir = process.argv[2] || fileURLToPath(new URL('..', import.meta.url));
console.log('== detectTier ==');
console.log(JSON.stringify(await detectTier(dir), null, 1));
console.log('== checkSecrets (S3) ==');
const s3 = await checkSecrets(dir);
console.log(JSON.stringify({ findings: s3.findings, coverageGap: s3.coverageGap }, null, 1));
console.log('== checkConfig (S5, L2) ==');
const s5 = await checkConfig(dir, 'L2');
console.log(JSON.stringify({ findings: s5.findings, coverageGap: s5.coverageGap }, null, 1));
