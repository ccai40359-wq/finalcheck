// 双轨纪律（2026-11-14 用户定案）：检验严格 fail-closed；开发听人类命令优先。
// 选轨按回合意图：验收/体检/审计/渗透等 → audit 轨（SYSTEM_BASE 原样）；
// 写码/改码/工具活 → dev 轨（SYSTEM_DEV_BASE：人类指令优先 + 底线三条）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSystemPromptParts } from '../desktop/src/main/agent-service.mjs';

test('双轨：audit 轨保留验收 fail-closed 纪律，dev 轨是人类指令优先', async () => {
  const audit = await getSystemPromptParts('audit');
  const dev = await getSystemPromptParts('dev');

  // audit 轨：验收纪律原样保留
  assert.match(audit.base, /验收前置（硬规则/);
  assert.match(audit.base, /验收档位纪律/);
  assert.match(audit.base, /安全验收助手/);
  assert.ok(!/人类指令优先/.test(audit.base), 'audit 轨不得混入 dev 纪律');

  // dev 轨：人类指令优先 + 直接动手 + 底线三条；不含验收前置硬规则
  assert.match(dev.base, /人类指令优先/);
  assert.match(dev.base, /直接动手做/);
  assert.match(dev.base, /底线（与模式无关）/, 'dev 轨保留写边界/灾难命令拦截/密钥三条底线');
  assert.match(dev.base, /最小验证/, 'dev 轨保留「改完跑最小验证」');
  assert.ok(!/验收前置（硬规则/.test(dev.base), 'dev 轨不得被验收前置反问绊住');
  assert.ok(!/验收档位纪律/.test(dev.base), 'dev 轨不带验收档位纪律');

  // 两轨共享：路径转义硬规则、工作流、语言纪律、方法论目录
  for (const p of [audit, dev]) {
    assert.match(p.base, /一律优先写正斜杠/, '路径转义硬规则两轨都要');
    assert.match(p.base, /depends_on/, '工作流纪律两轨都要');
    assert.ok(p.skills.length > 0, '方法论目录两轨都注入');
  }
});

test('选轨：默认 audit；getSystemPromptParts 缓存按 mode 分开', async () => {
  const d1 = await getSystemPromptParts('dev');
  const d2 = await getSystemPromptParts('dev');
  assert.equal(d1.base, d2.base, '同 mode 缓存一致');
  const audit = await getSystemPromptParts('audit');
  assert.notEqual(d1.base, audit.base, 'dev/audit 提示词不同');
  // 未知 mode 回落 audit（fail-closed：拿不准就用严格轨）
  const fallback = await getSystemPromptParts('unknown-mode');
  assert.equal(fallback.base, audit.base);
});
