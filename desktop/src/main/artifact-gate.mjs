// 产物/预览路径闸：agent 登记产物（present_artifact）与渲染层读产物（artifact:read/open）
// 必须走同一道策略闸，否则 agent 可以把 %APPDATA%\FinalCheck\config.json 或 ~/.ssh/id_rsa
// 登记成「产物」，用户点开就绕过了 read_file 的敏感路径限制（lane A 自查实测链）。
// 这里用 mode:'off' 的敏感闸：只拦敏感目录/私钥，不限制项目边界——产物本来就可能是
// spill 临时目录或用户桌面上的 png。
import path from 'node:path';
import { assertPathAllowed, createPolicy } from './policy.mjs';

let sensitiveOnlyPolicy = null;

/** 仅做敏感路径检查的策略（懒建，避免每次调用重算 home/env）。 */
export function sensitiveOnlyGate() {
  if (!sensitiveOnlyPolicy) sensitiveOnlyPolicy = createPolicy({ mode: 'off' });
  return sensitiveOnlyPolicy;
}

/**
 * @param {string} p 绝对或相对路径
 * @param {{policy?:object|null}} [opts] 传 agent 的 policy 时沿用它的模式（workspace/readonly/off）
 * @returns {{ok:boolean,path:string,reason?:string}}
 */
export function assertArtifactPath(p, { policy = null } = {}) {
  const abs = path.resolve(String(p || ''));
  const gate = assertPathAllowed(policy || sensitiveOnlyGate(), abs, { write: false, tool: 'artifact' });
  return gate.ok ? { ok: true, path: gate.path || abs } : { ok: false, path: abs, reason: gate.reason };
}
