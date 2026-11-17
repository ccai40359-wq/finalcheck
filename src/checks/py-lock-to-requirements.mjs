// Python 锁定文件的零依赖解析（2026-11-17）。
//
// 为什么需要这一层：S4 只把 requirements*.txt 判成 auditable，uv.lock / poetry.lock /
// Pipfile.lock 记成「生态未接入审计」→ 纯 uv/poetry 项目整份结论卡在「无法验收」。
// 而这几种锁文件里**包名与版本都是明确写死的**，读出来就能直接查漏洞库（见 py-osv.mjs）。
//
// 明确不做的：
//   · pyproject.toml：只有版本**范围**（>=0.3.81），不是锁定版本 → 不送审计库，
//     由 parsePyprojectDepNames 抽出「声明了哪些包」，交给调用方判断是否被同目录的
//     锁定审计覆盖（声明了却没被覆盖 = 真缺口，不能被 dev 依赖蒙混过去）。
//   · 依赖的传递解析：锁文件里已经是完整解析结果，直接读即可；不猜传递依赖。
//
// 解析用最小 TOML/JSON 读取（零依赖）：
//   uv.lock / poetry.lock：`[[package]]` 段 + `name = "x"` + `version = "1.2.3"`
//   Pipfile.lock：JSON 的 .default + .develop 每个键是包名，值是 {version: "==1.2.3"}
//
// 两个诚实性约束（2026-11-17 review 补）：
//   ① **不做静默跳过**：拿不到「精确版本」或来源不是 PyPI（git/path/url）的条目，
//      一律进 skipped 列表并由调用方写 warning —— 否则「没查过」会被读成「查过且没漏洞」。
//   ② **区分「合法但没有第三方包」与「解析失败」**：Pipfile 是 {"default":{}}、uv.lock 只有
//      元数据，都是合法锁文件（0 个包 = 0 条漏洞），不该把项目压成「无法验收」。

import { readFileSync } from 'node:fs';

/** 只接受精确版本（PEP 440 形态）；范围/通配/VCS marker 都不算「锁定」。 */
export function isExactVersion(v) {
  const s = String(v ?? '').trim();
  if (!s) return false;
  if (!/^\d/.test(s)) return false; // 版本必须以数字开头（1.2.3 / 2.0.0rc1 / 1!2.0）
  if (/[\s<>=~^*,;@\\/]/.test(s)) return false;
  return true;
}

/**
 * 从 uv.lock / poetry.lock（TOML）里抽出引用信息。
 * @returns {{deps: Array<{name,version,source}>? , skipped: Array<{name,version,reason}>}}
 *   deps 只含「可查漏洞库」的条目（PyPI 来源 + 精确版本）；
 *   skipped 是识别到了但没法查的（editable/自建项目、git/path/url 依赖、无精确版本）。
 */
export function parseTomlLock(text) {
  const deps = [];
  const skipped = [];
  let cur = null;
  let inSubTable = false; // 是否已进入 [[package]] 的子表（[package.dependencies] 等）
  const flush = () => {
    if (!cur || !cur.name) return;
    const name = cur.name;
    // 本地项目自身（uv.lock 的根包常是 editable/virtual）没有 PyPI 版本可查 ——
    // 它不是「漏查的第三方依赖」，直接跳过且不吵（记入 skipped，调用方按 source 区分）。
    if (cur.source === 'self') { skipped.push({ name, version: cur.version || '', reason: 'self', }); return; }
    if (cur.source === 'nonpypi') { skipped.push({ name, version: cur.version || '', reason: '非 PyPI 来源（git/path/url）' }); return; }
    if (!cur.version) { skipped.push({ name, version: '', reason: '没有 version 字段' }); return; }
    if (!isExactVersion(cur.version)) { skipped.push({ name, version: cur.version, reason: `版本不是精确锁定值（${cur.version}）` }); return; }
    deps.push({ name, version: cur.version });
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[[package]]')) {
      flush();
      cur = { name: null, version: null, source: 'pypi' };
      inSubTable = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('[')) {
      // [package.source] 是 poetry.lock 记录 git/path/url 来源的地方
      inSubTable = true;
      if (line.startsWith('[package.source]')) cur.source = 'nonpypi';
      continue;
    }
    if (inSubTable) {
      // 子表里的 name/version 不是包本身的；但 [package.source] 的 type 决定来源
      if (cur.source === 'nonpypi' && /^(?:type|git|url|path|directory)\s*=/.test(line)) cur.source = 'nonpypi';
      continue;
    }
    // source = { registry = ... } / { editable = "." } / { git = ... } 是单行内联表，
    // 不能要求右侧是引号字符串，单独处理
    if (/^source\s*=\s*\{/.test(line)) {
      if (/editable\s*=/i.test(line) || /virtual\s*=/i.test(line)) cur.source = 'self';
      else if (/git\s*=|\burl\s*=|\bpath\s*=|\bdirectory\s*=/i.test(line)) cur.source = 'nonpypi';
      continue;
    }
    const m = /^(name|version|develop)\s*=\s*("([^"]*)"|[a-z]+)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'name') cur.name = m[3] ?? null;
    else if (m[1] === 'version' && m[3] != null) cur.version = m[3];
    else if (m[1] === 'develop' && line.includes('true')) cur.source = 'self';
  }
  flush();
  return { deps, skipped };
}

/** 从 Pipfile.lock（JSON）里抽出引用信息。 */
export function parsePipfileLock(text) {
  let j;
  try { j = JSON.parse(String(text || '')); } catch { return { error: 'Pipfile.lock 不是合法 JSON' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 'Pipfile.lock 顶层不是对象' };
  const deps = [];
  const skipped = [];
  for (const section of ['default', 'develop']) {
    const block = j?.[section];
    if (!block || typeof block !== 'object') continue;
    for (const [name, meta] of Object.entries(block)) {
      if (!meta || typeof meta !== 'object') { skipped.push({ name, version: '', reason: '条目不是对象' }); continue; }
      // VCS / path 条目没有 version，只有 git/ref/file 字段
      if (meta.git || meta.path || meta.file) { skipped.push({ name, version: '', reason: '非 PyPI 来源（git/path/file）' }); continue; }
      const v = String(meta.version || '').replace(/^==\s*/, '').trim();
      if (!v || v === '*') { skipped.push({ name, version: v, reason: '未锁定版本' }); continue; }
      if (!isExactVersion(v)) { skipped.push({ name, version: v, reason: `版本不是精确锁定值（${v}）` }); continue; }
      deps.push({ name, version: v });
    }
  }
  return { deps, skipped };
}

/**
 * 按文件名选择解析器。
 * @returns {{deps:Array, skipped:Array, valid:boolean, error?:string}}
 *   valid=false 表示「格式不认识 / 读不出结构」；valid=true 且 deps 为空表示
 *   「合法锁文件但没有需要查的第三方包」（这是 0 漏洞，不是缺口）。
 */
export function parsePyLock(relPath, text) {
  const base = String(relPath || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (base === 'pipfile.lock') {
    const r = parsePipfileLock(text);
    if (r.error) return { deps: [], skipped: [], valid: false, error: r.error };
    return { deps: r.deps, skipped: r.skipped, valid: true };
  }
  if (base === 'uv.lock' || base === 'poetry.lock') {
    const s = String(text || '');
    // 合法 TOML 至少要有键值行；完全读不出（二进制/HTML/乱码）就是解析失败
    if (!/^[ \t]*[\w.-]+[ \t]*=/m.test(s)) return { deps: [], skipped: [], valid: false, error: '不是可识别的 TOML 文本' };
    const r = parseTomlLock(s);
    return { deps: r.deps, skipped: r.skipped, valid: true };
  }
  return { deps: [], skipped: [], valid: false, error: '不是支持锁文件类型' };
}

// 去掉行尾注释（引号里的 # 不算注释）
function stripTomlComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inStr = !inStr;
    else if (ch === '#' && !inStr) return line.slice(0, i);
  }
  return line;
}

/**
 * 抽出 pyproject.toml 声明的运行时依赖名（PEP 621 `[project].dependencies`
 * 与 poetry style `[tool.poetry.dependencies]`）。
 * 只取名，不看版本——版本是范围，本来就不该拿去查漏洞库。
 * @returns {{names:string[], dynamic:boolean, ok:boolean}}
 */
export function parsePyprojectDepNames(text) {
  const src = String(text || '');
  const names = [];
  const seen = new Set();
  const push = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return;
    // `name >=1.0 ; marker` / `name[extra]>=1` / `name~=1.2`
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*\[[^\]]*\])?\s*(?:[<>=~!^].*|;.*)?$/.exec(s);
    if (!m) return;
    const n = m[1].toLowerCase().replace(/[-_.]+/g, '-');
    if (seen.has(n)) return;
    seen.add(n);
    names.push(n);
  };

  if (!src.trim()) return { names: [], dynamic: false, ok: false };

  let section = '';
  let collecting = false; // 正在收集 dependencies 数组（可能跨行、字符串里可能有 ]）
  let buf = '';
  const flushArray = () => {
    for (const q of buf.matchAll(/"([^"]*)"/g)) push(q[1]);
    buf = '';
    collecting = false;
  };

  for (const rawLine of src.split('\n')) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (collecting) {
      // 继续收集，直到括号深度归零且不在字符串里。不能简单地找第一个 `]`：
      // "httpx[http2]==0.27" 里的 `]` 是 extras 的右括号，不是数组结束。
      buf += ' ' + line;
      let depth = 0;
      let inStr = false;
      let done = false;
      for (const ch of buf) {
        if (ch === '"') inStr = !inStr;
        else if (!inStr && ch === '[') depth++;
        else if (!inStr && ch === ']') { depth--; if (depth <= 0) { done = true; break; } }
      }
      if (done) flushArray();
      continue;
    }
    const head = /^\[([^\]]+)\]/u.exec(line);
    if (head) { section = head[1].trim().toLowerCase(); continue; }
    if (section === 'project') {
      if (/^dynamic\s*=/.test(line) && /dependencies/.test(line)) return { names: [], dynamic: true, ok: true };
      const m = /^dependencies\s*=\s*\[(.*)$/u.exec(line);
      if (m) {
        buf = m[1];
        // 单行闭合：括号深度归零
        let depth = 1;
        let inStr = false;
        let closed = false;
        for (const ch of buf) {
          if (ch === '"') inStr = !inStr;
          else if (!inStr && ch === '[') depth++;
          else if (!inStr && ch === ']') { depth--; if (depth === 0) { closed = true; break; } }
        }
        if (closed) flushArray();
        else collecting = true;
        continue;
      }
    }
    if (section === 'tool.poetry.dependencies' || section === 'tool.poetry.dev-dependencies') {
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/u.exec(line);
      if (!m) continue;
      if (m[1].toLowerCase() === 'python') continue; // 解释器约束不是包
      push(m[1]);
    }
  }
  return { names, dynamic: false, ok: true };
}

/** 读文件 → 解析。返回 {deps,skipped,valid} 或 {error}（读不到文件）。 */
export function requirementsTextFromLock(absPath, relPath) {
  let text;
  try { text = readFileSync(absPath, 'utf8'); } catch (e) {
    return { error: `无法读取（${e?.message || e}）` };
  }
  const r = parsePyLock(relPath, text);
  if (!r.valid) return { error: r.error || '锁文件格式不支持' };
  return { deps: r.deps, skipped: r.skipped, valid: true };
}
