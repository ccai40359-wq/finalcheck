// Browser use（2026-11-21）：对标 Playwright MCP，但复用 FC 自带的 Chromium。
//
// 为什么不用 Playwright：CC 官方是让用户自己 `claude mcp add playwright -- npx -y @playwright/mcp@latest`，
// 因为 CLI 没有浏览器。FC 是 Electron，自带 Chromium——再装 Playwright 要多几百 MB 二进制。
//
// 关键设计差异（照 Playwright MCP 而不是照像素截图）：
//   - snapshot 返回 **accessibility tree**（`- textbox "内容" [ref=e5]`），不是截图。
//     模型看到的是结构化元素 + 引用号，点的时候按 ref 点，不靠猜坐标。
//   - 每个 ref 映射到一个真实 DOM 节点；click/type 走 DOM 事件，不是模拟鼠标。
//   - 浏览器类任务优先走这条（CC 的路由优先级：MCP → Bash → Chrome 插件 → CU）。
//
// 安全：只在独立的 BrowserWindow 里跑，不碰主窗口；默认只允许 http/https。
import { BrowserWindow } from 'electron';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

let win = null;
let refMap = new Map(); // ref -> 元素路径选择器（用 XPath 保证唯一）

/** 从 URL 推断是否允许打开（只 http/https/file） */
function assertNavigableUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('缺少 url');
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('file://')) return s;
  // 允许本地绝对路径（转 file://）
  if (path.isAbsolute(s)) return pathToFileURL(s).href;
  throw new Error(`只允许 http/https 或本地文件路径，收到：${s.slice(0, 60)}`);
}

async function ensureWindow({ width = 1280, height = 900 } = {}) {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    show: false, // 默认不显示；需要「看着它操作」时用 show:true（见 open）
    width, height,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // 独立分区：不复用主会话的登录态，避免 AI 操作网页时带着用户的 cookie
      partition: 'fc-browser-use'
    }
  });
  win.on('closed', () => { win = null; refMap.clear(); });
  return win;
}

export function isOpen() { return !!(win && !win.isDestroyed()); }

export function close() {
  try { win?.destroy(); } catch { /* 已关 */ }
  win = null; refMap.clear();
}

/** 导航到 url（可指定是否显示窗口，让用户看着它操作） */
export async function navigate(url, { show = false, width = 1280, height = 900, waitMs = 600 } = {}) {
  const target = assertNavigableUrl(url);
  const w = await ensureWindow({ width, height });
  if (show) { try { w.show(); } catch { /* 无头环境 */ } }
  await w.loadURL(target);
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  return { ok: true, url: w.webContents.getURL(), title: w.webContents.getTitle() };
}

/**
 * 生成 accessibility tree（对标 Playwright MCP 的 browser_snapshot）。
 * 只返回模型能操作的、有语义的元素；每个带唯一 ref。
 */
export async function snapshot({ maxNodes = 220, includeText = true } = {}) {
  if (!isOpen()) return { ok: false, error: '浏览器还没打开，先调用 browser_navigate' };
  refMap = new Map();

  const result = await win.webContents.executeJavaScript(`(() => {
    const MAX = ${Number(maxNodes) || 220};
    const INCLUDE_TEXT = ${includeText !== false};

    // 元素路径：生成与重走必须用完全同一套算法（这是之前 click/type 全失效的根因——
    // 生成时算到 html 层，重走时却从 body 起跳，路径对不上）。
    // 这里把「生成」和「解析」都放进页面上下文里，共用 $__fcPath 与 $__fcResolve。
    window.__fcPath = (el) => {
      const parts = [];
      let cur = el;
      // 有 id 直接用它（最短最稳）
      if (cur.id) return '#' + cur.id;
      while (cur && cur !== document.body && cur.nodeType === 1) {
        const parent = cur.parentElement;
        if (!parent) break;
        let idx = 1;
        for (const sib of parent.children) {
          if (sib === cur) break;
          if (sib.tagName === cur.tagName) idx++;
        }
        parts.unshift(cur.tagName.toLowerCase() + ':' + idx);
        cur = parent;
      }
      return parts.join('/');
    };
    window.__fcResolve = (pathStr) => {
      if (!pathStr) return null;
      if (pathStr.startsWith('#')) return document.getElementById(pathStr.slice(1));
      const segs = pathStr.split('/').filter(Boolean);
      let cur = document.body;
      for (const seg of segs) {
        const [tag, idxStr] = seg.split(':');
        const idx = Number(idxStr) || 1;
        let n = 0, found = null;
        for (const sib of cur.children) {
          if (sib.tagName.toLowerCase() === tag && ++n === idx) { found = sib; break; }
        }
        if (!found) return null;
        cur = found;
      }
      return cur;
    };

    const pathOf = (el) => window.__fcPath(el);

    const interesting = new Set([
      'a','button','input','textarea','select','option','checkbox','radio',
      'label','form','nav','header','footer','main','section','article','aside',
      'h1','h2','h3','h4','table','tr','td','th','li','ul','ol','p','img','svg'
    ]);

    const lines = [];
    let count = 0;
    let refSeq = 0;
    window.__fcRefs = {};

    const walk = (el, depth) => {
      if (count >= MAX || !el || el.nodeType !== 1) return;
      const tag = (el.tagName || '').toLowerCase();
      const style = getComputedStyle(el);
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && el.getBoundingClientRect().width > 0;
      if (!visible) return;

      const role = el.getAttribute('role') || (tag === 'input' ? (el.type || 'textbox') : tag);
      const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') ||
                    (['a','button','input','textarea','select'].includes(tag) ? (el.innerText || el.value || '').trim() : '') ||
                    el.getAttribute('title') || '').replace(/\\s+/g, ' ').slice(0, 80);

      const actionable = ['a','button','input','textarea','select'].includes(tag) || el.getAttribute('role') === 'button' || el.onclick;

      if (interesting.has(tag) || role !== tag) {
        let line = '  '.repeat(depth) + '- ' + role;
        if (name) line += ' "' + name + '"';
        if (actionable) {
          const ref = 'e' + (++refSeq);
          window.__fcRefs[ref] = pathOf(el);
          line += ' [ref=' + ref + ']';
        }
        if (tag === 'input' && el.value) line += ' value="' + String(el.value).slice(0, 40) + '"';
        if (tag === 'a' && el.href) line += ' href="' + el.href.slice(0, 80) + '"';
        lines.push(line);
        count++;
      }

      if (INCLUDE_TEXT && ['p','h1','h2','h3','h4','li','td'].includes(tag)) {
        const txt = (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 100);
        if (txt) { lines.push('  '.repeat(depth + 1) + txt); count++; }
      }

      for (const child of el.children) walk(child, depth + (interesting.has(tag) ? 1 : 0));
    };

    walk(document.body, 0);

    return {
      title: document.title,
      url: location.href,
      tree: lines.join('\\n'),
      nodeCount: count,
      refs: window.__fcRefs,
      truncated: count >= MAX
    };
  })()`).catch((e) => ({ error: String(e?.message || e) }));

  if (result?.error) return { ok: false, error: result.error };
  // 把 ref 表带回来（主进程要在点击时用）
  for (const [ref, p] of Object.entries(result.refs || {})) refMap.set(ref, p);
  return {
    ok: true,
    title: result.title,
    url: result.url,
    tree: result.tree,
    nodeCount: result.nodeCount,
    truncated: result.truncated,
    note: '这是页面的可操作结构（不是截图）。点按钮/填表单请用 ref，不要猜像素坐标。'
  };
}

/** 按 ref 点一个元素（走 DOM click，不是模拟鼠标） */
export async function click(ref) {
  if (!isOpen()) return { ok: false, error: '浏览器还没打开，先调用 browser_navigate' };
  const p = refMap.get(String(ref || ''));
  if (!p) return { ok: false, error: `没有 ${ref} 这个 ref，先重新 browser_snapshot 拿最新引用` };
  const r = await win.webContents.executeJavaScript(`(() => {
    const cur = window.__fcResolve && window.__fcResolve(${JSON.stringify(p)});
    if (!cur) return { ok: false, error: '元素找不到了（页面可能已变化），先重新 browser_snapshot' };
    cur.scrollIntoView({ block: 'center' });
    if (cur.focus) cur.focus();
    cur.click();
    return { ok: true, tag: cur.tagName.toLowerCase(), text: (cur.innerText || '').slice(0, 60) };
  })()`).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  return r;
}

/** 往 input/textarea 里输入（走原生 setter，React 受控组件也能收到） */
export async function typeInto(ref, text) {
  if (!isOpen()) return { ok: false, error: '浏览器还没打开，先调用 browser_navigate' };
  const p = refMap.get(String(ref || ''));
  if (!p) return { ok: false, error: `没有 ${ref} 这个 ref，先重新 browser_snapshot` };
  const r = await win.webContents.executeJavaScript(`(() => {
    const cur = window.__fcResolve && window.__fcResolve(${JSON.stringify(p)});
    if (!cur) return { ok: false, error: '元素找不到了（页面可能已变化），先重新 browser_snapshot' };
    if (cur.focus) cur.focus();
    // React / Vue 用 value setter 拦截，必须用原型上的 setter 才能触发 onChange
    const proto = cur.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(cur, ${JSON.stringify(String(text))});
    else cur.value = ${JSON.stringify(String(text))};
    cur.dispatchEvent(new Event('input', { bubbles: true }));
    cur.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: String(cur.value).slice(0, 40) };
  })()`).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  return r;
}

/** 执行任意 JS（对标 browser_evaluate） */
export async function evaluate(expression) {
  if (!isOpen()) return { ok: false, error: '浏览器还没打开，先调用 browser_navigate' };
  const r = await win.webContents.executeJavaScript(`(async () => { return (${String(expression)}); })()`)
    .catch((e) => ({ __error: String(e?.message || e) }));
  if (r && r.__error) return { ok: false, error: r.__error };
  let text;
  try { text = JSON.stringify(r); } catch { text = String(r); }
  return { ok: true, result: text && text.length > 2000 ? text.slice(0, 2000) + '…' : text };
}

/** 读控制台错误（对标 browser_console_messages） */
export async function consoleMessages() {
  if (!isOpen()) return { ok: false, error: '浏览器还没打开' };
  const msgs = await win.webContents.executeJavaScript('(window.__fcConsole || []).slice(-50)').catch(() => []);
  return { ok: true, messages: msgs };
}

/** 抓一张截图（给用户看或需要像素判断时） */
export async function screenshot() {
  if (!isOpen()) return { ok: false, error: '浏览器还没打开' };
  const img = await win.webContents.capturePage();
  if (img.isEmpty()) return { ok: false, error: '截图为空' };
  return { ok: true, buf: img.toPNG(), mime: 'image/png', ...img.getSize() };
}

/** 装钩子：把 console 错误收进 window.__fcConsole（供模型查） */
export async function installConsoleHook() {
  if (!isOpen()) return;
  await win.webContents.executeJavaScript(`(() => {
    if (window.__fcConsoleHook) return;
    window.__fcConsoleHook = true;
    window.__fcConsole = [];
    const origErr = console.error;
    console.error = (...a) => { try { window.__fcConsole.push({ level: 'error', text: a.map(String).join(' ').slice(0, 300) }); } catch {} origErr.apply(console, a); };
    window.addEventListener('error', (e) => { try { window.__fcConsole.push({ level: 'uncaught', text: String(e.message).slice(0, 300) }); } catch {} });
  })()`).catch(() => {});
}
