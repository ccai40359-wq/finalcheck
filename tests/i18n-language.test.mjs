// 界面语言收敛：只有 zh / en 两态；旧配置 auto 落成实际值；AI 输出不再跟随界面语言。
// 外加一条覆盖率闸门：renderer 里用户可见的中文（t() 的 key、JSX 文本、title/placeholder 等属性）
// 必须能在 en 词典里查到；确实不译的专有名词/逻辑常量走白名单并写明理由。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import {
  LANGUAGES, resolveLanguage, setLanguage, getLanguage, t, hasTranslation
} from '../desktop/src/renderer/i18n/core.mjs';
import { TODO_DISPLAY_LABELS } from '../desktop/src/renderer/lib/todo.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const rendererRoot = path.join(repoRoot, 'desktop/src/renderer');
const CJK = /[\u3400-\u9fff]/;

const tmp = await mkdtemp(path.join(os.tmpdir(), 'fc-i18n-'));
after(async () => {
  setLanguage('zh');
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/* ---------------- 语言解析：两态 + 旧 auto 兼容 ---------------- */
test('i18n: resolveLanguage 只产出 zh/en，auto/缺省按系统语言落成实际值', () => {
  assert.equal(resolveLanguage('zh', 'en-US'), 'zh');
  assert.equal(resolveLanguage('en', 'zh-CN'), 'en');
  assert.equal(resolveLanguage('auto', 'zh-CN'), 'zh');
  assert.equal(resolveLanguage('auto', 'zh-Hant-TW'), 'zh');
  assert.equal(resolveLanguage('auto', 'en-US'), 'en');
  assert.equal(resolveLanguage(undefined, 'zh'), 'zh');
  assert.equal(resolveLanguage(undefined, ''), 'en');
  assert.equal(resolveLanguage(null, 'ja-JP'), 'en');
});

test('i18n: LANGUAGES 只有中文/English 两项（没有 auto）', () => {
  assert.deepEqual([...LANGUAGES], ['zh', 'en']);
  assert.ok(!LANGUAGES.includes('auto'));
});

test('i18n: t() 在 zh 返回原文、en 查词典，切换立即生效', () => {
  setLanguage('zh');
  assert.equal(t('保存'), '保存');
  assert.equal(t('共 {n} 条', { n: 3 }), '共 {n} 条'.replace('{n}', '3'));
  setLanguage('en');
  assert.equal(getLanguage(), 'en');
  assert.equal(t('保存'), 'Save');
  setLanguage('zh');
});

/* ---------------- 保存写回 zh/en，旧 auto 读成实际值 ---------------- */
test('i18n: 保存配置只写 zh/en；旧 auto 读取时落成实际语言', async () => {
  const { createConfigStore } = await import('../desktop/src/main/ipc/config-store.mjs');
  const dataRoot = path.join(tmp, 'cfg');
  const file = path.join(dataRoot, 'config.json');
  process.env.FINALCHECK_CONFIG_FILE = file;
  await mkdir(dataRoot, { recursive: true });
  const store = createConfigStore({
    app: { getLocale: () => 'zh-CN' },
    getDataRoot: () => dataRoot,
    engineUrl: () => 'file:///nonexistent-engine.mjs' // providerLimits 加载失败按未配置处理
  });

  await store.saveConfig({ language: 'auto', providers: [] });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).language, 'zh', '旧 auto 保存后必须落成 zh');
  await store.saveConfig({ language: 'en', providers: [] });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).language, 'en');
  await store.saveConfig({ language: 'zh', providers: [] });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).language, 'zh');

  // 旧配置文件里的 auto：load 返回实际值（不要求改写盘上文件）
  await writeFile(file, JSON.stringify({ language: 'auto', providers: [] }), 'utf8');
  assert.equal((await store.loadConfig()).language, 'zh');
  delete process.env.FINALCHECK_CONFIG_FILE;
});

/* ---------------- 覆盖率闸门 ---------------- */
// 读完即去注释（保留字符串），避免把注释里的中文算进来。
function stripComments(src) {
  let out = '';
  let i = 0;
  let state = null; // 'line' | 'block' | 引号字符
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'line') {
      if (c === '\n') { state = null; out += c; } else out += ' ';
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = null; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i += 1; continue;
    }
    if (state) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === state) state = null;
      i += 1; continue;
    }
    if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue; }
    if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { state = c; out += c; i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}

function rendererSources() {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { if (name !== 'node_modules' && name !== 'i18n') walk(p); continue; }
      if (/\.(jsx?|mjs)$/.test(name)) files.push(p);
    }
  })(rendererRoot);
  return files.map((file) => ({
    file: path.relative(repoRoot, file).replace(/\\/g, '/'),
    src: stripComments(readFileSync(file, 'utf8'))
  }));
}

// 白名单：确实不需要翻译的“逻辑常量/专有名词”，每条写理由。保持尽量短。
const NON_TRANSLATABLE = new Set([
  '程序检查', // step-view.mjs 里对比历史 role 字段，不是展示文案
  '时间线', '预算', '收尾', // ContinueButton.errorIsRecoverable 里匹配错误文本的关键词
  '新增', '新功能', '修复', '改进', '优化', '变更' // CHANGELOG 段落别名；展示只用 新增/修复/优化（已译）
]);

test('i18n 闸门：t() 里的中文 key 都能在 en 词典查到', () => {
  const missing = [];
  for (const { file, src } of rendererSources()) {
    const re = /(?:^|[^\w$.])t\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = re.exec(src))) {
      const key = m[2];
      if (!CJK.test(key) || NON_TRANSLATABLE.has(key)) continue;
      if (!hasTranslation(key)) {
        missing.push(`${file}:${src.slice(0, m.index).split('\n').length} ${key}`);
      }
    }
  }
  assert.deepEqual(missing, [], `以下 t() 文案缺英文：\n${missing.join('\n')}`);
});

test('i18n 闸门：JSX 里没有裸中文文本节点（必须包 t()）', () => {
  const offenders = [];
  for (const { file, src } of rendererSources()) {
    const re = />([^<>{}\n]*[\u3400-\u9fff][^<>{}\n]*)</g;
    let m;
    while ((m = re.exec(src))) {
      offenders.push(`${file}:${src.slice(0, m.index).split('\n').length} ${m[1].trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `JSX 裸中文文本节点：\n${offenders.join('\n')}`);
});

test('i18n 闸门：title/placeholder/aria-label/alt/label 里的中文必须包 t()', () => {
  const offenders = [];
  const re = /\b(title|placeholder|aria-label|alt|label)\s*=\s*"([^"]*[\u3400-\u9fff][^"]*)"/g;
  for (const { file, src } of rendererSources()) {
    let m;
    while ((m = re.exec(src))) {
      const text = m[2].trim();
      if (NON_TRANSLATABLE.has(text)) continue;
      offenders.push(`${file}:${src.slice(0, m.index).split('\n').length} ${m[1]}="${text}"`);
    }
  }
  assert.deepEqual(offenders, [], `以下界面属性是裸中文：\n${offenders.join('\n')}`);
});

test('i18n 闸门：动态标签（验收单状态 / 更新按钮 / 严重度）都有英文', () => {
  const dynamicKeys = [
    ...Object.values(TODO_DISPLAY_LABELS),
    '等待中', '运行中', '已完成', '失败', '已取消', '应用重启导致中断',
    '高危', '中危', '低危',
    '检查更新', '下载更新', '重启并安装', '尚未检查更新', '检查更新失败', '未知版本',
    '新增', '修复', '优化'
  ];
  const missing = dynamicKeys.filter((k) => !hasTranslation(k));
  assert.deepEqual(missing, [], `动态标签缺英文：${missing.join(' / ')}`);
});

test('i18n: 工作流职位名与 kind 标签随界面语言切换（新卡片中英双语）', async () => {
  const {
    agentTitleFor, agentKindLabel, AGENT_KIND_LABELS, AGENT_TITLE_RULES
  } = await import('../desktop/src/main/agent-titles.mjs');

  setLanguage('zh');
  assert.equal(agentTitleFor({ prompt: '检查 SQL 注入' }), '注入面审查员');
  assert.equal(agentTitleFor({ kind: 'find' }), '取证审查员');
  assert.equal(agentTitleFor({ index: 3 }), '审查员 #3');
  assert.equal(agentKindLabel('find'), '取证');

  setLanguage('en');
  assert.equal(agentTitleFor({ prompt: '检查 SQL 注入' }), 'Injection Reviewer');
  assert.equal(agentTitleFor({ kind: 'find' }), 'Evidence Reviewer');
  assert.equal(agentTitleFor({ kind: 'report' }), 'Report Editor');
  assert.equal(agentTitleFor({ index: 3 }), 'Reviewer #3');
  assert.equal(agentKindLabel('find'), 'Evidence');
  assert.equal(agentKindLabel('arbitrate'), 'Arbitration');

  // 14 个职位名都要有英文
  for (const rule of AGENT_TITLE_RULES) {
    assert.ok(hasTranslation(rule.title), `职位名缺英文：${rule.title}`);
  }
  const titles = [
    agentTitleFor({ prompt: '检查 SQL 注入' }),
    agentTitleFor({ goal: '审计鉴权与越权', prompt: '按目录逐个看' }),
    agentTitleFor({ role: '性能压测', prompt: '跑一下' }),
    ...Object.keys(AGENT_KIND_LABELS).map((k) => agentTitleFor({ kind: k })),
    agentTitleFor({})
  ];
  for (const title of titles) {
    assert.ok(title && title.trim(), '职位名不能为空');
    assert.ok(!CJK.test(title), `英文界面下职位名不应含中文：${title}`);
    assert.ok(!/步骤|step/i.test(title), `职位名不能是序号名：${title}`);
  }
  // kind 标签在英文下全部为英文文案，且与中文不同
  for (const [kind, zhLabel] of Object.entries(AGENT_KIND_LABELS)) {
    const en = agentKindLabel(kind);
    assert.ok(en, `${kind} 缺英文标签`);
    assert.ok(!CJK.test(en), `${kind} 英文标签含中文：${en}`);
    assert.notEqual(en, zhLabel, `${kind} 英文标签不应与中文相同`);
  }
  setLanguage('zh');
});

test('i18n 解耦：代码里不再有 withOutputLanguage / lang.mjs（界面语言不再绑架 AI 输出）', () => {
  const hits = [];
  const scan = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (name !== 'node_modules' && name !== 'benchmark' && name !== 'fixtures' && name !== '.mimosa') scan(p);
        continue;
      }
      if (!/\.(mjs|js|jsx|cjs)$/.test(name)) continue;
      if (path.resolve(p) === import.meta.filename) continue; // 断言自身的模式串不算残留
      const src = readFileSync(p, 'utf8');
      if (/\bwithOutputLanguage\b|\boutputLanguageRule\b|\bmain[\\/]lang\.mjs\b|\bfrom '\.\/lang\.mjs'/.test(src)) {
        hits.push(path.relative(repoRoot, p).replace(/\\/g, '/'));
      }
    }
  };
  for (const r of ['desktop/src', 'tests', 'scripts']) scan(path.join(repoRoot, r));
  assert.deepEqual(hits, [], `仍残留输出语言耦合：${hits.join(', ')}`);
});
