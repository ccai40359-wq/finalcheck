// Browser automation uses FinalCheck's Chromium with an isolated browsing session.
//
// 0.31.0 三模式（2 个宿主 + 2 种存储策略，选择逻辑见 ./browser-session.mjs）：
//   ① 离屏无痕（默认）：partition 'fc-browser-use'，session 在内存，关窗即丢
//   ② 离屏持久：partition 'persist:fc-browser-use'，cookie 写进 userData/Partitions/，重开 FC 仍在
//   ③ CDP 接真 Edge：browser-real.mjs（端口 9224），本模块不参与
// partition 创建后不能改：resolvePartition 的结果与当前窗口不一致时必须先关窗再重建，
// 否则同一进程里会同时存在两套 cookie（登录态看起来「一会儿有一会儿没有」）。
import { BrowserWindow } from 'electron';
import { randomBytes } from 'node:crypto';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { resolvePartition, PARTITION_ONESHOT } from './browser-session.mjs';

const WORLD_ID = 1742;
const CONSOLE_LEVELS = ['verbose', 'info', 'warning', 'error'];
const NO_BROWSER = '浏览器还没打开，先调用 browser_navigate';
const NAVIGATING = '页面正在导航，完成后请调用 browser_snapshot 获取当前页面';
const webRequestSessions = new WeakMap(); // session -> { pending: Set<requestId> }（fc-browser-use partition 专属）

let active = null;
// 当前策略（由 ensureWindow 按配置解析后写入）：只影响 ensureWindow 是否要重建窗口。
let activePolicy = { mode: 'oneshot', chosen: false, persistent: false, partition: PARTITION_ONESHOT };

function assertNavigableUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) throw new Error('缺少 url');
  if (/^https?:\/\//i.test(url) || url.startsWith('file://')) return url;
  if (path.isAbsolute(url)) return pathToFileURL(url).href;
  throw new Error(`只允许 http/https 或本地文件路径，收到：${url.slice(0, 60)}`);
}

// 0.29.2：settle 判定改用隔离世界里的 MutationObserver 计数 + resource 条目——
// fetch/XHR 完成后的 DOM 更新必然使 mutations 增长，比 debugger 注入计数器可靠（实测 debugger
// 在离屏 sandbox 窗口上 attach/sendCommand 超时）。详见 waitSettled。
//
// 0.31.0：policy 由调用方按配置解析后传入（见 browser-session.mjs 的 sessionPolicyOf）。
//
// 窗口生命周期与 policy 的关系（关键）：
//   - 窗口不存在 → 按 policy 建
//   - 窗口存在且 partition 一致 → 复用（无痕/持久各自保持自己的 cookie）
//   - 窗口存在但 partition 不一致 → 先 destroy 再建（BrowserWindow 的 partition 创建后不能改；
//     不重建就会留下两套 cookie，用户看到「登录态时有时无」）
function ensureWindow({ width, height }, policy = null) {
  const want = policy && typeof policy === 'object' ? policy : activePolicy;
  if (isOpen()) {
    // 策略没变就复用现有窗口（含用户显式切换后再调 navigate 的情形）
    if (want.partition === activePolicy.partition) return active;
    close(); // 策略变了：先关掉旧窗口（renderer 进程连同它的 cookie 一起回收），下面按新策略重建
  }
  const partition = want.partition || resolvePartition(want.persistent === true);
  const window = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      partition
    }
  });
  activePolicy = { ...want, partition };
  const state = { window, messages: [], request: 0, generation: 0, action: 0, navigating: false, policy: { ...activePolicy } };
  const contents = window.webContents;
  // 0.29.2：在飞请求计数（session.webRequest，按请求 id 精确增减）——waitSettled 用它判断
  // 「页面自己发起的请求是否都回来了」。fetch/XHR 在飞时 DOM 一片平静，只有这个信号能看到它。
  // 会话级只挂一次（partition 专属、无其它使用方）；主帧导航开始时清空在飞计数（重定向链残留自愈）。
  {
    const ses = window.webContents.session;
    if (!webRequestSessions.has(ses)) {
      const pending = new Set();
      const wr = ses.webRequest;
      const filter = { urls: ['*://*/*'] };
      wr.onBeforeRequest(filter, (d, cb) => { pending.add(String(d.id)); cb({}); });
      // onCompleted/onErrorOccurred 的监听器没有 callback 形参——多调一次会让请求管线卡死
      wr.onCompleted(filter, (d) => pending.delete(String(d.id)));
      wr.onErrorOccurred(filter, (d) => pending.delete(String(d.id)));
      webRequestSessions.set(ses, { pending });
    }
    state.netPending = () => webRequestSessions.get(ses).pending.size;
  }
  contents.on('did-start-navigation', (details, _url, _samePage, mainFrame) => {
    if (details.isMainFrame ?? mainFrame) {
      state.generation++;
      // 0.29.2：换页即作废旧文档的 ref 缓存——重绑定只允许在同一个文档内发生，
      // 杜绝「另一个页面上恰好同签名的控件」被误绑（审查 P0-1 的跨页变体）。
      contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: 'delete globalThis[Symbol.for("finalcheck.browser-use")]' }], false).catch(() => { /* 旧 world 尚不存在 */ });
      if (active === state) { try { webRequestSessions.get(window.webContents.session)?.pending.clear(); } catch { /* ignore */ } }
    }
  });
  contents.on('did-frame-navigate', (_event, _url, _code, _status, mainFrame) => {
    if (mainFrame) state.messages.length = 0;
  });
  contents.on('console-message', (details, level, message) => {
    state.messages.push({
      level: CONSOLE_LEVELS[level] ?? details.level ?? 'info',
      text: String(message ?? details.message ?? '').slice(0, 300)
    });
    if (state.messages.length > 50) {
      const routine = state.messages.findIndex((entry) => entry.level === 'info' || entry.level === 'verbose');
      state.messages.splice(Math.max(0, routine), 1);
    }
  });
  window.on('closed', () => { if (active === state) active = null; });
  active = state;
  return state;
}

// This function is serialized into a Chromium isolated world. Its private map
// holds exact elements; it never looks up an element by ID or position.
function createPageState(salt) {
  const maxRefs = 4096;
  const refs = new Map();
  const elementRefs = new WeakMap();
  let sequence = 0;
  const actionTags = new Set(['button', 'input', 'textarea', 'select', 'summary']);
  const actionRoles = new Set([
    'button', 'checkbox', 'combobox', 'link', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton',
    'switch', 'tab', 'textbox', 'treeitem'
  ]);
  const structuralTags = new Set([
    'a', 'article', 'aside', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
    'h6', 'header', 'img', 'label', 'li', 'main', 'meter', 'nav', 'ol', 'option', 'output',
    'p', 'progress', 'section', 'table', 'td', 'th', 'tr', 'ul'
  ]);
  const textTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'output', 'p', 'td']);
  const liveRoles = new Set(['alert', 'log', 'status', 'timer']);
  const valueRoles = new Set(['meter', 'progressbar', 'scrollbar', 'slider', 'spinbutton']);
  const textInputTypes = new Set(['email', 'number', 'password', 'search', 'tel', 'text', 'url']);
  const skipTags = new Set(['noscript', 'script', 'style', 'template']);

  // 0.29.2：节点被移除时不再直接删除 ref——保留 entry 并标记 dead，让 tryRebind 拿得到身份
  // 签名做「同一控件找回」；真找不到（重绑失败）时 stale 照旧拒绝。
  let mutationCount = 0;
  function invalidateRemoved(records) {
    for (const record of records) {
      for (const removed of record.removedNodes) {
        if (removed.nodeType !== Node.ELEMENT_NODE) continue;
        const deadRef = elementRefs.get(removed);
        if (deadRef) { const entry = refs.get(deadRef); if (entry) entry.dead = true; }
        for (const child of removed.querySelectorAll('*')) {
          const childRef = elementRefs.get(child);
          if (childRef) { const childEntry = refs.get(childRef); if (childEntry) childEntry.dead = true; }
        }
      }
    }
  }

  const observer = new MutationObserver((records) => { invalidateRemoved(records); mutationCount++; });
  observer.observe(document, { childList: true, subtree: true });
  // 0.29.2：淘汰 ref 时优先清已失效（dead）的条目，减少重渲染页面误淘汰活 ref 的概率
  function evictRef() {
    for (const key of refs.keys()) { if (refs.get(key)?.dead) { refs.delete(key); return; } }
    refs.delete(refs.keys().next().value);
  }

  function refFor(element, identity) {
    let ref = elementRefs.get(element);
    if (refs.get(ref)?.identity === identity) return ref;
    refs.delete(ref);
    ref = `e${salt}-${(++sequence).toString(36)}`;
    elementRefs.set(element, ref);
    refs.set(ref, { element, identity });
    if (refs.size > maxRefs) evictRef();
    return ref;
  }

  function isAttached(ref, entry) {
    invalidateRemoved(observer.takeRecords());
    const element = entry?.element;
    return Boolean(element?.isConnected && element.ownerDocument === document && refs.get(ref) === entry);
  }

  const stale = () => ({ ok: false, error: '引用已失效，先调用 browser_snapshot 获取当前元素的 ref' });
  const failure = (error) => ({ ok: false, error });
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const disabled = (element) => element.matches(':disabled') || element.closest('[aria-disabled="true"], [inert]');
  const visible = (element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });

  function roleOf(element, tag, editable) {
    const explicit = normalize(element.getAttribute('role')).split(' ', 1)[0].slice(0, 40);
    if (explicit) return explicit;
    if (editable || tag === 'textarea') return 'textbox';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'output') return 'status';
    if (tag === 'progress') return 'progressbar';
    if (tag === 'summary') return 'button';
    if (tag === 'select') return element.multiple || element.size > 1 ? 'listbox' : 'combobox';
    if (tag !== 'input') return tag;
    if (['button', 'image', 'reset', 'submit'].includes(element.type)) return 'button';
    if (element.type === 'number') return 'spinbutton';
    if (element.type === 'range') return 'slider';
    if (element.type === 'search') return 'searchbox';
    return textInputTypes.has(element.type) ? 'textbox' : element.type;
  }

  function referencedLabel(element) {
    return normalize(element.getAttribute('aria-labelledby')?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent).join(' '));
  }

  function labelOf(element, role, actionable) {
    const formLabels = Array.from(element.labels || [], (label) => label.textContent).join(' ');
    const controlText = role === 'button' && element.tagName === 'INPUT' ? element.value
      : actionable && !element.isContentEditable ? element.innerText : '';
    return normalize(referencedLabel(element) || element.getAttribute('aria-label') || normalize(formLabels) ||
      element.getAttribute('alt') || controlText || element.getAttribute('placeholder') || element.title);
  }

  function linkTarget(element) {
    if (!element.hasAttribute('href')) return '';
    return normalize(element.href?.baseVal ?? element.href ?? element.getAttribute('href'));
  }

  function contentOf(element, tag, role) {
    if (textTags.has(tag) || liveRoles.has(role) || element.hasAttribute('aria-live')) {
      return normalize(element.innerText);
    }
    if (valueRoles.has(role)) {
      return normalize(element.getAttribute('aria-valuetext') ?? element.getAttribute('aria-valuenow') ??
        (tag === 'input' && element.type === 'password' ? '' : element.value));
    }
    return '';
  }

  function identityOf(element, role, name, href) {
    const context = [];
    const rowTags = ['li', 'tr'];
    for (let ancestor = element.parentElement; ancestor && context.length < 8; ancestor = ancestor.parentElement) {
      const row = rowTags.includes(ancestor.localName) || ancestor.getAttribute('role') === 'row';
      context.push([ancestor.id, ancestor.getAttribute('data-id'), ancestor.getAttribute('data-key'),
        ancestor.getAttribute('role'), ancestor.getAttribute('aria-label'), referencedLabel(ancestor).slice(0, 240),
        row ? normalize(ancestor.innerText).slice(0, 240) : '']);
    }
    const form = element.form || element.closest('form');
    return JSON.stringify([role, name, href, element.id, element.getAttribute('name'),
      element.getAttribute('type'), element.getAttribute('formaction'), element.getAttribute('aria-controls'),
      element.getAttribute('data-id'), element.getAttribute('data-key'), element.getAttribute('onclick'),
      form ? [form.action, form.method, form.target] : null, context]);
  }

  function readTree({ maxNodes, includeText, query }) {
    invalidateRemoved(observer.takeRecords());
    const lines = [];
    let truncated = false;
    const match = query.toLowerCase();
    const stack = document.body ? [{ element: document.body, depth: 0 }] : [];
    while (stack.length) {
      const { element, depth } = stack.pop();
      const tag = element.localName.toLowerCase();
      if (skipTags.has(tag) || element.getAttribute('aria-hidden') === 'true') continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || Number(style.opacity) === 0) continue;

      const editable = element.isContentEditable && !element.parentElement?.isContentEditable;
      const role = roleOf(element, tag, editable);
      const actionable = actionTags.has(tag) || actionRoles.has(role) || editable || element.hasAttribute('onclick');
      const describe = (actionable || structuralTags.has(tag) || element.hasAttribute('role') ||
        element.hasAttribute('aria-live')) && visible(element);
      let childDepth = depth;
      if (describe) {
        const name = labelOf(element, role, actionable);
        const href = linkTarget(element);
        const content = includeText || match ? contentOf(element, tag, role) : '';
        if (!match || `${role} ${name} ${content} ${href}`.toLowerCase().includes(match)) {
          if (lines.length === maxNodes) { truncated = true; break; }
          let line = `${'  '.repeat(depth)}- ${role}`;
          if (name) line += ` ${JSON.stringify(name.slice(0, 80))}`;
          if (actionable) line += ` [ref=${refFor(element, identityOf(element, role, name, href))}]`;
          if (actionable && disabled(element)) line += ' [disabled]';
          if ((tag === 'input' || tag === 'textarea') && element.readOnly) line += ' [readonly]';
          if (tag === 'input' && element.type !== 'password' && element.value) {
            line += ` value=${JSON.stringify(String(element.value).slice(0, 40))}`;
          }
          if (href) line += ` href=${JSON.stringify(href.slice(0, 80))}`;
          lines.push(line);
          childDepth++;
          if (includeText && content) {
            if (lines.length === maxNodes) { truncated = true; break; }
            lines.push(`${'  '.repeat(childDepth)}${content.slice(0, 100)}`);
          }
        }
      }
      for (let child = element.lastElementChild; child; child = child.previousElementSibling) {
        stack.push({ element: child, depth: childDepth });
      }
    }
    return { title: document.title, url: location.href, tree: lines.join('\n'), nodeCount: lines.length, truncated,
      rebindDebug: globalThis.__fcRebind || null,
      probe: { mutations: mutationCount, ready: document.readyState, resources: performance.getEntriesByType('resource').length } };
  }

  function checkAction(ref, entry) {
    if (!isAttached(ref, entry)) {
      if (!tryRebind(ref, entry)) return stale();
    }
    const { element, identity } = entry;
    const editable = element.isContentEditable && !element.parentElement?.isContentEditable;
    const role = roleOf(element, element.localName, editable);
    if (identityOf(element, role, labelOf(element, role, true), linkTarget(element)) !== identity) {
      refs.delete(ref);
      return stale();
    }
    if (!visible(element) || element.closest('[aria-hidden="true"]')) return failure('元素不可见');
    if (disabled(element)) return failure('元素已禁用');
    return null;
  }

  // 0.29.2：ref 失效时先尝试「身份重绑定」。页面重渲染会整体替换 DOM 节点（React/Vue 常态），
  // 旧 ref 持有的元素已死，但「同一个控件」几乎总还在。用快照时记录的身份签名（角色/名称/
  // 属性/祖先上下文）在全文档找唯一匹配：恰好 1 个 → 原地改 entry 重绑同一个 ref，省一次
  // snapshot 往返；0 个或 ≥2 个（同名控件无法区分，绑错会静默点错）→ 保持 stale，fail-closed。
  function tryRebind(ref, entry) {
    const signature = entry?.identity;
    if (!signature) return false;
    invalidateRemoved(observer.takeRecords());
    const candidates = document.querySelectorAll('button,a,input,textarea,select,summary,[role],[onclick],[contenteditable]');
    const matches = [];
    for (const el of candidates) {
      if (!el.isConnected) continue;
      const tag = el.localName.toLowerCase();
      const editable = el.isContentEditable && !el.parentElement?.isContentEditable;
      const role = roleOf(el, tag, editable);
      if (!actionTags.has(tag) && !actionRoles.has(role) && !editable && !el.hasAttribute('onclick')) continue;
      if (!visible(el) || disabled(el)) continue;
      if (identityOf(el, role, labelOf(el, role, true), linkTarget(el)) !== signature) continue;
      matches.push(el);
    }
    if (matches.length !== 1) {
      globalThis.__fcRebind = { ok: false, matches: matches.length, scanned: candidates.length, sigLen: signature.length };
      return false;
    }
    const el = matches[0];
    entry.element = el;
    entry.dead = false;
    elementRefs.set(el, ref);
    refs.set(ref, entry);
    globalThis.__fcRebind = { ok: true, matches: 1 };
    return true;
  }

  function receivesClick(element) {
    for (const rect of element.getClientRects()) {
      const left = Math.max(0, rect.left);
      const right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top);
      const bottom = Math.min(innerHeight, rect.bottom);
      if (left >= right || top >= bottom) continue;
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (element.contains(hit)) return true;
    }
    return false;
  }

  const occluded = () => failure('元素被遮挡或无法操作');

  function checkHit(ref, entry) {
    return checkAction(ref, entry) || (receivesClick(entry.element) ? null : occluded());
  }

  async function scrollIfNeeded(ref, entry) {
    const { element } = entry;
    if (receivesClick(element)) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    // Scroll handlers may replace this control or place an overlay above it.
    await new Promise(requestAnimationFrame);
    return checkHit(ref, entry);
  }

  async function focusElement(ref, entry) {
    const { element } = entry;
    const previous = document.activeElement;
    let focused = false;
    const onFocus = () => { focused = true; };
    element.addEventListener('focus', onFocus);
    element.focus?.({ preventScroll: true });
    element.removeEventListener('focus', onFocus);
    if (!focused && !document.hasFocus() && previous !== element && document.activeElement === element) {
      // Hidden Chromium views can change activeElement without sending focus events.
      element.dispatchEvent(new FocusEvent('focus', { composed: true, relatedTarget: previous }));
      if (isAttached(ref, entry)) {
        element.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true, relatedTarget: previous }));
      }
    }
    // Let the microtasks queued by the focus handlers finish before dispatch.
    await new Promise((resume) => globalThis.setTimeout(resume, 0));
  }

  async function clickElement(ref) {
    const entry = refs.get(ref);
    let error = checkAction(ref, entry) || await scrollIfNeeded(ref, entry);
    if (error) return error;
    await focusElement(ref, entry);
    error = checkHit(ref, entry);
    if (error) return error;
    const { element } = entry;
    const result = { ok: true, tag: element.localName, text: (element.innerText || '').slice(0, 60) };
    if (typeof element.click === 'function') element.click();
    else element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    return result;
  }

  async function typeInElement(ref, text) {
    const entry = refs.get(ref);
    let error = checkAction(ref, entry);
    if (error) return error;
    const { element } = entry;
    const input = element instanceof HTMLInputElement && textInputTypes.has(element.type);
    const textarea = element instanceof HTMLTextAreaElement;
    const editable = element instanceof HTMLElement && element.isContentEditable;
    if (!input && !textarea && !editable) return failure('元素不是可输入的文本控件');
    if (element.readOnly || element.closest('[aria-readonly="true"]')) return failure('元素为只读');

    error = await scrollIfNeeded(ref, entry);
    if (error) return error;
    await focusElement(ref, entry);
    error = checkHit(ref, entry);
    if (error) return error;
    if ((input && !textInputTypes.has(element.type)) || (editable && !element.isContentEditable)) {
      return failure('元素已变为不可输入的控件');
    }
    if (element.readOnly || element.closest('[aria-readonly="true"]')) return failure('元素为只读');
    if (document.activeElement !== element) return failure('元素未获得输入焦点');

    if (editable) {
      element.textContent = text;
    } else {
      const proto = textarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (input && element.type === 'number' && text) {
        const validator = document.createElement('input');
        validator.type = 'number';
        setter.call(validator, text);
        if (!validator.value) return failure('输入内容不符合数字字段的格式');
      }
      setter.call(element, text);
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: text }));
    if (isAttached(ref, entry)) element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: String(editable ? element.textContent : element.value).slice(0, 40) };
  }

  return { snapshot: readTree, click: clickElement, typeInto: typeInElement,
    netProbe: () => ({ ready: document.readyState, mutations: mutationCount, resources: performance.getEntriesByType('resource').length }) };
}

const pageStateSource = createPageState.toString();

function runInPage(state, method, ...args) {
  if (active !== state || !isOpen()) return Promise.resolve({ ok: false, error: NO_BROWSER });
  const cacheKey = "Symbol.for('finalcheck.browser-use')";
  const code = `(globalThis[${cacheKey}] ??= (${pageStateSource})('${randomBytes(9).toString('hex')}')).${method}(...${JSON.stringify(args)})`;
  return state.window.webContents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }])
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
}

export function isOpen() { return Boolean(active && !active.window.isDestroyed()); }

// 当前窗口的策略（无痕 / 持久）。没窗口时返回最近一次解析出的策略，
// 供 UI 在「接下来会用什么模式」这种场景显示标识。
export function sessionInfo() {
  if (isOpen() && active.policy) return { ...active.policy };
  return { ...activePolicy };
}

export function close() {
  const state = active;
  active = null;
  if (state && !state.window.isDestroyed()) state.window.destroy();
}

// 0.29.2：loadURL 完成 ≠ 页面可用（SPA 异步渲染 + 接口取数，实测快照常停在「正在加载」）。
// 三重平静判定：主帧不在加载/等响应 + document readyState=complete + 资源条目数稳定
// （fetch/XHR 完成会新增 performance resource 条目），连续两次平静才交快照；上限 maxMs，
// 快页面通常 1-2 次轮询（约 240ms）就过，慢接口最多等 maxMs。
async function waitSettled(state, maxMs = 2000) {
  const start = Date.now();
  let calm = 0;
  let last = null;
  while (Date.now() - start < maxMs) {
    await setTimeout(120);
    if (!active || active !== state || state.window.isDestroyed()) return;
    const contents = state.window.webContents;
    const busy = contents.isLoading() || contents.isWaitingForResponse() || (state.netPending ? state.netPending() > 0 : false);
    const page = await runInPage(state, 'netProbe');
    const p = (page && page.ok !== false) ? page : null;
    const pageBusy = !p || p.ready !== 'complete';
    const changed = !!(last && p && (p.mutations !== last.mutations || p.resources !== last.resources));
    last = p || last;
    calm = (!busy && !pageBusy && !changed) ? calm + 1 : 0;
    if (calm >= 2) return;
  }
}

export async function navigate(url, { show = false, width = 1280, height = 900, waitMs = 0, observe = false, policy = null } = {}) {
  const target = assertNavigableUrl(url);
  const state = ensureWindow({ width, height }, policy);
  const { window } = state;
  const request = ++state.request;
  state.navigating = true;
  try {
    if (show) window.show();
    await window.loadURL(target);
    if (waitMs > 0) await setTimeout(waitMs);
    await waitSettled(state);
    if (state !== active || state.request !== request) return { ok: false, error: NAVIGATING };
    const generation = state.generation;
    const result = { ok: true, url: window.webContents.getURL(), title: window.webContents.getTitle() };
    if (observe) result.snapshot = await readSnapshot(state);
    if (state !== active || state.request !== request || state.generation !== generation) {
      return { ok: false, error: NAVIGATING };
    }
    return result;
  } catch (error) {
    if (state !== active || state.request !== request) return { ok: false, error: NAVIGATING };
    throw error;
  } finally {
    if (state.request === request) state.navigating = false;
  }
}

async function readSnapshot(state, { maxNodes = 220, includeText = true, query = '' } = {}) {
  const { request, generation } = state;
  const limit = Math.max(1, Math.min(2000, Math.floor(Number(maxNodes)) || 220));
  const result = await runInPage(state, 'snapshot', {
    maxNodes: limit, includeText: includeText !== false, query: String(query ?? '').trim()
  });
  if (state !== active || state.request !== request || state.generation !== generation) {
    return { ok: false, error: NAVIGATING };
  }
  if (result?.ok === false) return result;
  if (!result) return { ok: false, error: '页面上下文已变化，请重新调用 browser_snapshot' };
  return {
    ok: true, ...result,
    note: '可用 ref 点击和填写页面控件。'
  };
}

export async function snapshot(options) {
  if (!isOpen()) return { ok: false, error: NO_BROWSER };
  return readSnapshot(active, options);
}

function canAct(state) {
  return !state.navigating && !state.window.webContents.isLoadingMainFrame();
}

export async function click(ref, { observe = false } = {}) {
  if (!isOpen()) return { ok: false, error: NO_BROWSER };
  const state = active;
  if (!canAct(state)) return { ok: false, error: NAVIGATING };
  const request = state.request;
  const action = ++state.action;
  const result = await runInPage(state, 'click', String(ref || ''));
  if (!result) return { ok: false, error: '页面上下文已变化，请重新调用 browser_snapshot' };
  if (result.ok && observe) {
    // Let Chromium begin any navigation triggered by the click before sampling.
    await setImmediate();
    const observation = await readSnapshot(state);
    if (observation.ok) observation.note = '这是点击后的即时页面状态。若结果仍在加载，可再获取页面结构。';
    result.snapshot = state.request === request && state.action === action
      ? observation : { ok: false, error: '页面已有后续操作，请调用 browser_snapshot 获取当前页面' };
  }
  return result;
}

export async function typeInto(ref, text) {
  if (!isOpen()) return { ok: false, error: NO_BROWSER };
  const state = active;
  if (!canAct(state)) return { ok: false, error: NAVIGATING };
  state.action++;
  return await runInPage(state, 'typeInto', String(ref || ''), String(text)) ||
    { ok: false, error: '页面上下文已变化，请重新调用 browser_snapshot' };
}

export async function evaluate(expression) {
  if (!isOpen()) return { ok: false, error: NO_BROWSER };
  const result = await active.window.webContents.executeJavaScript(`(async () => { return (${String(expression)}); })()`)
    .catch((error) => ({ __error: String(error?.message || error) }));
  if (result && result.__error) return { ok: false, error: result.__error };
  let text;
  try { text = JSON.stringify(result); } catch { text = String(result); }
  return { ok: true, result: text && text.length > 2000 ? text.slice(0, 2000) + '…' : text };
}

export async function consoleMessages() {
  if (!isOpen()) return { ok: false, error: NO_BROWSER };
  return { ok: true, messages: active.messages.slice() };
}

export async function screenshot() {
  if (!isOpen()) return { ok: false, error: NO_BROWSER };
  const img = await active.window.webContents.capturePage();
  if (img.isEmpty()) return { ok: false, error: '截图为空' };
  return { ok: true, buf: img.toPNG(), mime: 'image/png', ...img.getSize() };
}

// Kept callable for older consumers. The listener is attached before navigation.
export async function installConsoleHook() {}
