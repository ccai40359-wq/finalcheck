// 方法论库可见性回归（2026-11-20）
// 实测：跨 9 会话 1188 次工具调用，list_playbooks / read_playbook 各 0 次。
// 两个根因都在这测：
// 1) 工具描述写「开始渗透测试时先调用它」——验收场景的模型读到「渗透测试」就认为不关自己事；
// 2) dev 轨的系统提示里根本没有 41-50 修复技能目录（renderCatalog 只覆盖 web-vuln 01-40），
//    模型只看到「topic=对应编号 41-50」这句话，不知道每号是什么东西。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSystemPromptParts, TOOLS_SCHEMA } from '../desktop/src/main/agent-service.mjs';
import { loadCatalog, loadSkills, renderCatalog } from '../src/playbooks.mjs';

const descOf = (name) => {
  const t = TOOLS_SCHEMA.find((x) => x.function?.name === name);
  return t ? String(t.function.description || '') : '';
};

test('playbooks: list_playbooks 描述不再只面向渗透测试', () => {
  const d = descOf('list_playbooks');
  assert.ok(d.length > 50, '描述必须存在');
  assert.ok(/验收|交付|修复|审计/.test(d), `描述要覆盖验收/修复场景（实际：${d.slice(0, 120)}）`);
  // 不能只有「渗透测试」这一个触发语境
  const penOnly = /渗透测试/.test(d) && !/验收|修复|审计|交付/.test(d);
  assert.equal(penOnly, false, '不能只写渗透测试');
});

test('playbooks: read_playbook 描述说明 41-50 是修复技能', () => {
  const d = descOf('read_playbook');
  assert.ok(/41-50|41–50/.test(d), `要说明 41-50 的存在（实际：${d.slice(0, 160)}）`);
  assert.ok(/修复/.test(d), '要说明这是修复技能');
});

test('playbooks: 描述不再写死错误的类目数量（桌面 50 / MCP 40 会撒谎）', () => {
  // 同一份 TOOLS_SCHEMA 被桌面端（loadSkills → 50）与 MCP（loadCatalog → 40）共用，
  // 写死任何一个数字都会让另一个通道撒谎。
  for (const n of ['list_playbooks', 'read_playbook']) {
    const d = descOf(n);
    assert.ok(!/40 个类目|50 个类目|40 类漏洞/.test(d), `${n} 描述里不能写死类目数（实际：${d.slice(0, 100)}）`);
  }
});

test('playbooks: dev 轨系统提示包含 41-50 修复技能目录', async () => {
  const parts = await getSystemPromptParts('dev');
  const skills = String(parts.skills || '');
  assert.ok(skills.length > 300, 'dev 轨必须有方法论段（以前这里是 web-vuln 的 40 类，与修复无关）');
  // 41-50 的编号必须真的出现在上下文里，否则模型只能瞎猜
  for (const id of ['41', '43', '45', '50']) {
    assert.ok(new RegExp(`(^|\\n)${id} `, 'm').test(skills), `dev 轨目录里缺 ${id} 号技能（实际：${skills.slice(0, 200)}）`);
  }
  assert.ok(/密钥轮换|注入修复|运维就绪/.test(skills), '目录行要带中文名');
});

test('playbooks: audit 轨仍保留 01-40 漏洞手法目录', async () => {
  const parts = await getSystemPromptParts('audit');
  const skills = String(parts.skills || '');
  const catalog = await loadCatalog();
  assert.ok(catalog.length >= 40, `web-vuln 目录应有 40 类（实际 ${catalog.length}）`);
  assert.ok(skills.includes('方法论库'), 'audit 轨必须有方法论段');
  // 抽查一个已知类目名，确认不是空目录
  assert.ok(/ssrf|sql-injection|SSRF|注入/.test(skills.toLowerCase()), 'audit 轨目录要含具体类目');
});

test('playbooks: 41-50 不在 renderCatalog(loadCatalog()) 里（这条是「只改描述无效」的机械证据）', async () => {
  // dev 轨以前用的就是 renderCatalog(loadCatalog())，而 loadCatalog 只读 web-vuln → 41-50 从没进过上下文。
  // 这条测试锁住这个事实，防止有人把 dev 轨改回去。
  const webOnly = renderCatalog(await loadCatalog());
  const all = await loadSkills({});
  const fix = all.filter((e) => e.domain === 'dev-fix');
  assert.ok(fix.length >= 10, `dev-fix 应有 10 类（实际 ${fix.length}）`);
  assert.ok(!/(^|\n)41 /.test(webOnly), 'renderCatalog(loadCatalog()) 不应包含 41 号（说明它只覆盖 web-vuln）');
  assert.ok(/(^|\n)41 /.test(renderCatalog(fix)), 'renderCatalog(dev-fix) 必须包含 41 号');
});
