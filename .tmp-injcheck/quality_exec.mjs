// 只读演示：finalcheck.quality.json 里声明的命令原样进 shell:true（含 shell 元字符）
import { checkQuality } from '../src/checks/quality.mjs';
const dir = 'D:/rcw-geo/yanshou/.tmp-injcheck/proj';
const r = await checkQuality(dir, { tier: 'L2', run: true });
console.log(JSON.stringify(r.runs, null, 2));
