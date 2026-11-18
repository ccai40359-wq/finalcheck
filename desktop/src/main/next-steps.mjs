// audit_project 结果里的「下一步建议」（2026-11-18）。
//
// 真实模型 E2E（6 个仓库）里 list_playbooks / read_playbook / run_workflow / review_diff / quality_gate
// 一次都没被调用过——系统提示里写了，但 flash 级模型对系统提示的服从远不如对工具结果的服从。
// 所以把「该用哪个工具做什么」直接写进 audit_project 的返回值里，并且具体到 topic 编号与路径。

// 发现规则 → 验证方法论（web-vuln 01-40）与修复技能（dev-fix 41-50）
const RULE_TOPICS = [
  [/sqli|sql-inject|mybatis|S2\.sql/i, '05', 'sql-injection'],
  [/xss/i, '06', 'xss'],
  [/cmdi|command|exec-|S2\.exec/i, '07', 'command-injection'],
  [/upload/i, '08', 'file-upload'],
  [/path-traversal|file-inclusion|lfi/i, '09', 'path-traversal-lfi'],
  [/xxe/i, '10', 'xxe'],
  [/ssrf/i, '11', 'ssrf'],
  [/deserial|pickle|yaml-load|unserialize/i, '12', 'deserialization'],
  [/ssti|template/i, '13', 'ssti'],
  [/code-injection|eval|spel|expression/i, '15', 'el-injection'],
  [/open-redirect|redirect/i, '30', 'open-redirect'],
  [/cors/i, '27', 'cors-misconfig'],
  [/csrf/i, '28', 'csrf'],
  [/jwt/i, '23', 'jwt-token-attacks'],
  [/^S7\.|idor|owner/i, '21', 'idor'],
  [/^S1\.|auth|guard/i, '22', 'auth-bypass'],
];
const FIX_TOPICS = { S1: '42', S2: '43', S3: '41', S4: '44', A1: '45', A2: '46', A3: '47', A4: '48', H1: '49', O1: '50' };

/**
 * @param {object} r audit() 的返回
 * @param {{dir:string, codeFiles?:number, mode?:'audit'|'dev', hasQualityConfig?:boolean}} ctx
 * @returns {string[]} 3-6 条可直接执行的建议（带工具名与参数）
 */
export function auditNextSteps(r, { dir = '', codeFiles = 0, hasQualityConfig = false } = {}) {
  const out = [];
  const findings = Array.isArray(r?.findings) ? r.findings : [];
  const blocking = findings.filter((f) => f.force === 'card' || f.force === 'check');
  // ① 可疑安全发现 → 先按方法论确认是否真能利用（不是凭感觉判真假）
  const topics = new Map();
  for (const f of blocking) {
    const rule = `${f.rule || ''} ${(f.relatedRules || []).join(' ')}`;
    const hit = RULE_TOPICS.find(([re]) => re.test(rule));
    if (hit && !topics.has(hit[1])) topics.set(hit[1], { topic: hit[1], name: hit[2], sample: `${f.file}:${f.line}` });
  }
  if (topics.size) {
    const list = [...topics.values()].slice(0, 4).map((x) => `read_playbook(topic="${x.topic}")（${x.name}，例：${x.sample}）`).join('、');
    out.push(`确认高危发现是否真能被利用：先 ${list}，按其「验证」段逐条复核，复核过的写「已确认 + 证据」，没复核的写「疑似」——不要只凭规则名下结论`);
  }
  // ② 大仓库 → 并行分路复核
  if (codeFiles >= 150 || blocking.length >= 25) {
    out.push(`仓库较大（约 ${codeFiles} 个源码文件、${blocking.length} 条需处理发现）：用 run_workflow 按目录或问题类型分 3-6 路并行复核（每路一个子代理，depends_on 留空），比一个人逐个 read_file 快得多`);
  }
  // ③ 有量化质量配置 → 跑出可测量证据
  if (hasQualityConfig) out.push('项目根有 finalcheck.quality.json：调用 quality_gate 跑 lint / typecheck / test 拿可测量证据，再下「可维护 / 可测试」结论');
  // ④ 未跑的关 → 原样列进 Not covered
  const gaps = r?.gates?.gaps || [];
  if (gaps.length) out.push(`gates.gaps 里 ${gaps.length} 关没跑：最终回答的 ## Not covered 逐条原样列出原因，不能说成通过`);
  // ⑤ 修复（开发轨）→ 修复技能 + 改完 review_diff
  const fixIds = [...new Set(blocking.map((f) => FIX_TOPICS[f.checkId]).filter(Boolean))].slice(0, 3);
  if (fixIds.length) out.push(`如果要修：先 read_playbook(topic="${fixIds.join('" / "')}") 读修复技能；改完调用 review_diff(dir="${dir}") 复查改动，再重跑 audit_project 确认对应项归零`);
  return out.slice(0, 6);
}
