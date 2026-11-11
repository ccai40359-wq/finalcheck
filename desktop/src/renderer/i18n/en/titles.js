// 工作流职位名 / kind 小标签的英文词典（主进程 agent-titles.mjs 与渲染层共用）
// key = 中文原文（AGENT_KIND_LABELS / KIND_TITLES / AGENT_TITLE_RULES 里的常量）
export const EN_TITLES = {
  // 14 个职位名（关键词规则）
  '注入面审查员': 'Injection Reviewer',
  '鉴权与越权审查员': 'Authz & IDOR Reviewer',
  '密钥与凭证审计员': 'Secret & Credential Auditor',
  '供应链合规专员': 'Supply-chain Compliance Specialist',
  '数据与隐私专员': 'Data & Privacy Officer',
  '测试覆盖审查员': 'Test Coverage Reviewer',
  '性能分析员': 'Performance Analyst',
  '运维与可观测性专员': 'Ops & Observability Specialist',
  '代码可读性审查员': 'Readability Reviewer',
  '项目侦察员': 'Project Recon Scout',
  '交付与交接专员': 'Delivery & Handover Officer',
  '交付报告主编': 'Report Editor',
  '红队复核员': 'Red-team Reviewer',
  '争议仲裁员': 'Dispute Arbitrator',

  // kind 兜底职位名
  '取证审查员': 'Evidence Reviewer',
  '程序校验员': 'Program Validator',
  '轮次调度员': 'Round Coordinator',
  '递归调度员': 'Recursion Coordinator',
  '分支调度员': 'Branch Coordinator',
  '审查员': 'Reviewer',

  // 12 个 kind 小标签
  '侦察': 'Recon',
  '取证': 'Evidence',
  '复核': 'Verify',
  '仲裁': 'Arbitration',
  '汇总': 'Summary',
  '门禁': 'Gate',
  '聚合': 'Aggregate',
  '轮询': 'Poll',
  '递归': 'Recurse',
  '执行': 'Execute',
  '分支': 'Branch',
  '程序': 'Program'
};
