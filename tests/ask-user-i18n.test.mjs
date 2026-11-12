// ask_user 卡片英文界面：选项/描述/结果行按已知中文片段翻译；提交仍用原始 label。
// 不引入 jsdom：显示路径用纯函数断言，接线用源码断言。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { setLanguage } from '../desktop/src/renderer/i18n/core.mjs';
import { translateAskText } from '../desktop/src/renderer/lib/ask-user-i18n.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const CJK = /[\u3400-\u9fff]/;

const DIMS = [
  '安全性', '数据与隐私', '供应链与许可证', '可维护性', '代码可读性', '可测试性',
  '鲁棒性', '运行稳定性', '性能', '可观测性与可运维', '可移交性'
];
const DIMS_EN = [
  'Security', 'Data & privacy', 'Supply chain & license', 'Maintainability', 'Readability',
  'Testability', 'Robustness', 'Runtime stability', 'Performance', 'Observability & ops', 'Handover'
];

after(() => { setLanguage('zh'); });

test('ask-user i18n: 11 维列表在 en 下全部变英文且不含 CJK', () => {
  const zhList = DIMS.join(' / ');
  const enList = translateAskText(zhList, 'en');
  assert.equal(enList, DIMS_EN.join(' / '));
  assert.ok(!CJK.test(enList), `英文维度列表仍含中文：${enList}`);
  for (const name of DIMS_EN) assert.ok(enList.includes(name), `缺少英文维度：${name}`);

  // 系统提示现在是「中文 (English)」；模型整段照抄时也不能出现「Security (Security)」
  assert.equal(
    translateAskText(DIMS.map((d, i) => `${d} (${DIMS_EN[i]})`).join(' / '), 'en'),
    DIMS_EN.join(' / ')
  );

  // 截图里的实际写法：首维被模型简写成「安全」，末尾用省略号截断
  assert.equal(
    translateAskText('安全 / 数据与隐私 / 供应链与许可证 / 可维护性…', 'en'),
    'Security / Data & privacy / Supply chain & license / Maintainability…'
  );
});

test('ask-user i18n: zh 原样返回；en 只替换已知片段，未知中文保留', () => {
  setLanguage('zh');
  assert.equal(translateAskText('安全性 / 自定义维度'), '安全性 / 自定义维度');
  assert.equal(translateAskText('安全性', 'zh'), '安全性', '显式 zh 不查词典');

  setLanguage('en');
  assert.equal(translateAskText('安全性 / 自定义维度'), 'Security / 自定义维度');
  assert.equal(translateAskText('自定义维度'), '自定义维度', '未知中文不得瞎翻');
  assert.equal(translateAskText('安全性'), 'Security', '默认取当前界面语言');
  setLanguage('zh');
});

test('ask-user i18n: 混合分隔符保留结构（ / 、· ；），不改变排版', () => {
  assert.equal(
    translateAskText('安全性 / 数据与隐私 · 供应链与许可证、可维护性；代码可读性', 'en'),
    'Security / Data & privacy · Supply chain & license、Maintainability；Readability'
  );
  assert.equal(translateAskText('（安全性）', 'en'), '（Security）');
});

test('ask-user i18n: 最长优先——「代码可读性」不会被「可读性」截成「代码Readability」', () => {
  assert.equal(translateAskText('代码可读性', 'en'), 'Readability');
  assert.equal(translateAskText('可读性', 'en'), 'Readability');
  assert.equal(translateAskText('运行稳定性', 'en'), 'Runtime stability');
  assert.equal(translateAskText('安全性', 'en'), 'Security');
});

test('ask-user i18n: 档位选项说明的固定短语有英文', () => {
  assert.equal(translateAskText('全选 = 完整验收', 'en'), 'Select all = full acceptance');
  assert.equal(translateAskText('完整验收', 'en'), 'full acceptance');
  assert.equal(translateAskText('查什么', 'en'), 'what it checks');
  assert.equal(
    translateAskText('基础安全与依赖有没有硬伤', 'en'),
    'basic security and dependency issues'
  );
});

test('ask-user i18n: AskUserCard 显示走 translateAskText，提交仍用原始 label', () => {
  const src = readFileSync(path.join(repoRoot, 'desktop/src/renderer/components/AskUserCard.jsx'), 'utf8');
  assert.match(src, /import \{ translateAskText \} from '\.\.\/lib\/ask-user-i18n\.mjs';/);
  assert.match(src, /import \{ useLanguage \} from '\.\.\/i18n\/index\.jsx';/);
  assert.match(src, /const lang = useLanguage\(\)/);

  // 显示文本：问题 / 标签 / 描述 / 结果行
  assert.match(src, /\{translateAskText\(data\.question, lang\)\}/);
  assert.match(src, /\{translateAskText\(label, lang\)\}/);
  assert.match(src, /\{translateAskText\(opt\.description, lang\)\}/);
  assert.match(src, /translateAskText\(payload\.answer, lang\)/);

  // 交互与提交必须仍用原始 label（主进程按原文匹配）
  assert.match(src, /const label = String\(opt\?\.label \?\? ''\)/);
  assert.match(src, /const active = selected\.includes\(label\)/);
  assert.match(src, /onClick=\{\(\) => onOption\(label\)\}/);
  assert.match(src, /if \(multi\) toggle\(label\)/);
  assert.match(src, /else void submit\(\[label\]\)/);
  assert.match(src, /await onSubmit\(\{ selected: picks, text: typed \}\);/);
  assert.ok(!/onOption\(translateAskText/.test(src), 'onOption 不能传译文');
  assert.ok(!/submit\(\[translateAskText/.test(src), '单选提交不能传译文');
});

test('ask-user i18n: agent-service 审计前置问法含英文维度名与英文选项指令', () => {
  const src = readFileSync(path.join(repoRoot, 'desktop/src/main/agent-service.mjs'), 'utf8');
  for (const [zh, en] of DIMS.map((d, i) => [d, DIMS_EN[i]])) {
    assert.ok(src.includes(`${zh} (${en})`), `系统提示缺少英文维度名：${zh} (${en})`);
  }
  assert.ok(
    src.includes('If the UI/user language is English, write ask_user option labels and descriptions in English.'),
    '系统提示缺少英文选项指令'
  );
});
