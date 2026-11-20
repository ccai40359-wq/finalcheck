// Browser automation uses FinalCheck's Chromium with an isolated browsing session.
import { BrowserWindow } from 'electron';
import { randomBytes } from 'node:crypto';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const WORLD_ID = 1742;
const CONSOLE_LEVELS = ['verbose', 'info', 'warning', 'error'];
const NO_BROWSER = '浏览器还没打开，先调用 browser_navigate';
const NAVIGATING = '页面正在导航，完成后请调用 browser_snapshot 获取当前页面';

let active = null;

function assertNavigableUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) throw new Error('缺少 url');
  if (/^https?:\/\//i.test(url) || url.startsWith('file://')) return url;
  if (path.isAbsolute(url)) return pathToFileURL(url).href;
  throw new Error(`只允许 http/https 或本地文件路径，收到：${url.slice(0, 60)}`);
}

function ensureWindow({ width, height }) {
  if (isOpen()) return active;
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
      partition: 'fc-browser-use'
    }
  });
  const state = { window, messages: [], request: 0, generation: 0, action: 0, navigating: false };
  const contents = window.webContents;
  contents.on('did-start-navigation', (details, _url, _samePage, mainFrame) => {
    if (details.isMainFrame ?? mainFrame) state.generation++;
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

  function invalidateRemoved(records) {
    for (const record of records) {
      for (const removed of record.removedNodes) {
        if (removed.nodeType !== Node.ELEMENT_NODE) continue;
        refs.delete(elementRefs.get(removed));
        for (const child of removed.querySelectorAll('*')) refs.delete(elementRefs.get(child));
      }
    }
  }

  const observer = new MutationObserver(invalidateRemoved);
  observer.observe(document, { childList: true, subtree: true });

  function refFor(element, identity) {
    let ref = elementRefs.get(element);
    if (refs.get(ref)?.identity === identity) return ref;
    refs.delete(ref);
    ref = `e${salt}-${(++sequence).toString(36)}`;
    elementRefs.set(element, ref);
    refs.set(ref, { element, identity });
    if (refs.size > maxRefs) refs.delete(refs.keys().next().value);
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
    return { title: document.title, url: location.href, tree: lines.join('\n'), nodeCount: lines.length, truncated };
  }

  function checkAction(ref, entry) {
    if (!isAttached(ref, entry)) return stale();
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

  return { snapshot: readTree, click: clickElement, typeInto: typeInElement };
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

export function close() {
  const state = active;
  active = null;
  if (state && !state.window.isDestroyed()) state.window.destroy();
}

export async function navigate(url, { show = false, width = 1280, height = 900, waitMs = 0, observe = false } = {}) {
  const target = assertNavigableUrl(url);
  const state = ensureWindow({ width, height });
  const { window } = state;
  const request = ++state.request;
  state.navigating = true;
  try {
    if (show) window.show();
    await window.loadURL(target);
    if (waitMs > 0) await setTimeout(waitMs);
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
