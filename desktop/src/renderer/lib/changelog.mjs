// CHANGELOG.md 纯函数解析：主进程 IPC 与测试共用（无 Electron / React 依赖）
// 输入是仓库根的 CHANGELOG.md 文本，输出按文件顺序（新版本在前）的条目：
//   { version, date?, added[], fixed[], improved[] }
// 解析原则：脏 Markdown 不抛异常、不产生 undefined；认不出的段落与条目直接忽略。

const SECTION_KEYS = [
  { key: 'added', names: ['新增', '新功能', 'added', 'add', 'new', 'features', 'feature'] },
  { key: 'fixed', names: ['修复', 'fixed', 'fix', 'bugfix', 'bug fixes', 'bug fix', 'bugs'] },
  { key: 'improved', names: ['优化', '改进', '变更', 'improved', 'improve', 'changed', 'change', 'enhancement', 'enhancements'] }
];

// 版本号：去掉方括号 / v 前缀，只留 x.y.z(-pre)(+build)；日期写在标题同一行
const VERSION_RE = /^v?(\d+(?:\.\d+)*)(?:[-+][0-9A-Za-z.-]+)?$/i;
const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

const asText = (v) => (typeof v === 'string' ? v : '');

export function normalizeVersion(value) {
  const raw = asText(value).trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  const noPrefix = raw.replace(/^v/i, '');
  const m = noPrefix.match(VERSION_RE);
  return m ? m[0].toLowerCase() : '';
}

export function versionNumbers(value) {
  const v = normalizeVersion(value);
  if (!v) return null;
  const core = v.split(/[-+]/)[0];
  return core.split('.').map((n) => Number.parseInt(n, 10) || 0);
}

// 0.13 与 0.13.0 视为同一版本（历史 tag 有 v0.13，package.json 是 0.13.0）
export function sameVersion(a, b) {
  const na = versionNumbers(a);
  const nb = versionNumbers(b);
  if (!na || !nb) return false;
  const len = Math.max(na.length, nb.length);
  for (let i = 0; i < len; i += 1) {
    if ((na[i] ?? 0) !== (nb[i] ?? 0)) return false;
  }
  return true;
}

function sectionKey(title) {
  const name = asText(title).trim().toLowerCase().replace(/[:：]$/, '');
  if (!name) return null;
  return SECTION_KEYS.find((s) => s.names.includes(name))?.key ?? null;
}

function headingVersion(text) {
  // `## [0.13.0] - 2026-11-11` / `## v0.1.2` / `## 0.13.0`
  const body = asText(text).trim();
  if (!body) return { version: '', date: '' };
  const bracket = body.match(/^\[([^\]]+)\]/);
  const token = (bracket ? bracket[1] : body.split(/\s+/)[0]).trim();
  const version = normalizeVersion(token);
  const date = (body.match(DATE_RE) || [])[1] || '';
  return { version, date };
}

function bulletText(line) {
  const m = asText(line).match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
  return m ? m[1].trim() : '';
}

/**
 * 解析 CHANGELOG.md 文本。
 * @param {string} md
 * @returns {{ version: string, date?: string, added: string[], fixed: string[], improved: string[] }[]}
 */
export function parseChangelog(md) {
  const text = asText(md).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return [];

  const entries = [];
  const byVersion = new Map();
  let current = null;
  let section = null;

  for (const line of text.split('\n')) {
    // 标题必须顶格；缩进的四级标题按正文处理
    const h2 = line.match(/^##(?!#)\s+(.*)$/);
    if (h2) {
      const { version, date } = headingVersion(h2[1]);
      current = null;
      section = null;
      if (!version) continue; // Unreleased / 无法识别的小节标题：跳过其内容
      const existing = byVersion.get(version);
      if (existing) {
        // 重复标题：合并到已完成条目，避免出现两份同名版本
        current = existing;
        if (!existing.date && date) existing.date = date;
      } else {
        const entry = { version, added: [], fixed: [], improved: [] };
        if (date) entry.date = date;
        entries.push(entry);
        byVersion.set(version, entry);
        current = entry;
      }
      continue;
    }

    const h3 = line.match(/^###(?!#)\s+(.*)$/);
    if (h3) {
      section = current ? sectionKey(h3[1]) : null;
      continue;
    }

    if (!current || !section) continue;
    const item = bulletText(line);
    if (!item) continue;
    const bucket = current[section];
    if (!bucket.includes(item)) bucket.push(item);
  }

  return entries;
}

/**
 * 按版本找条目；支持 v 前缀与 0.13 / 0.13.0 等价。
 * @param {ReturnType<typeof parseChangelog>} entries
 * @param {string} version
 * @returns {object|null}
 */
export function entryFor(entries, version) {
  if (!Array.isArray(entries) || !normalizeVersion(version)) return null;
  const exact = normalizeVersion(version);
  return entries.find((e) => normalizeVersion(e?.version) === exact)
    || entries.find((e) => sameVersion(e?.version, version))
    || null;
}

/**
 * 从原文抽出某个版本的完整段落（含标题，不含下一个版本）。
 * 用于 `gh release create --notes-file`：Release 正文与 CHANGELOG 保持同一份文字。
 * @param {string} md
 * @param {string} version
 * @returns {string}
 */
export function changelogSection(md, version) {
  const text = asText(md).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.trim() || !normalizeVersion(version)) return '';
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const h2 = lines[i].match(/^##(?!#)\s+(.*)$/);
    if (!h2) continue;
    if (start >= 0) return lines.slice(start, i).join('\n').trim();
    const { version: found } = headingVersion(h2[1]);
    if (found && sameVersion(found, version)) start = i;
  }
  return start >= 0 ? lines.slice(start).join('\n').trim() : '';
}

/**
 * 把条目拆成「当前版本 + 更早版本」，供界面渲染。
 * @param {ReturnType<typeof parseChangelog>} entries
 * @param {string} version
 */
export function changelogView(entries, version) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e.version === 'string' && e.version) : [];
  const currentEntry = entryFor(list, version);
  const history = currentEntry ? list.filter((e) => e !== currentEntry) : list;
  return { current: currentEntry, history, empty: list.length === 0 };
}

/**
 * 按界面语言挑选更新条目：en 且英文条目非空时用英文，否则回退中文。
 * 英文文件缺失时 entriesEn 是空数组，这里必须回退中文，不能让界面出现空白。
 * @param {string} lang 当前界面语言（'zh' / 'en'）
 * @param {{ entries?: object[], entriesEn?: object[] }} data IPC 返回值（或同类结构）
 * @returns {object[]}
 */
export function pickChangelogEntries(lang, data) {
  const zh = Array.isArray(data?.entries) ? data.entries : [];
  const en = Array.isArray(data?.entriesEn) ? data.entriesEn : [];
  return lang === 'en' && en.length > 0 ? en : zh;
}
