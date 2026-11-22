// UIA（UI Automation）优先点击适配器 —— 0.30.0
//
// 为什么需要它：0.29.7 的遮挡校验把「点击落点顶层窗口不属于目标」一律拒绝。对 UIA 富应用
// （WinUI/WPF/Win32 标准控件）其实有更安全的第二条路：走无障碍接口直接 Invoke 控件，
// 完全不依赖像素可见性——窗口被别的窗口压住也能点中。
//
// ⚠️ 实测纠正（2026-11-22，D:/fc-bench-0291/uia-poc/）：
//   AutomationElement.FromPoint(x,y) 是「屏幕这一点上是谁」的 z-order 命中测试，被遮挡时返回
//   **遮挡窗**的元素（实测点落在记事本菜单区、遮挡者是另一个记事本时，返回遮挡记事本的
//   RichEditD2DPT，pid=遮挡进程）。所以「只按命中点 FromPoint」无法穿透遮挡。
//   唯一可行的穿透路径：目标窗口 FromHandle(targetHwnd) → 在**它自己的 UIA 子树**里按几何
//   包含命中（取面积最小的包含元素）→ 归属断言 → 沿祖先链找可 Invoke 的控件 → Invoke。
//   这条路径与像素可见性无关，正是穿透的要害。
//
// 通道选择：不用 winapp CLI（本机未安装，且它没有 invoke 子命令的可信契约），自写 C# UIA COM，
// 宿主沿用 desktop-input-win 的常驻 PowerShell 模式（启动一次、之后每命令几十毫秒）。
// 与输入注入宿主**分开**：UIA 加载 UIAutomation 程序集、可能因目标应用无响应而卡住，
// 不能拖累键鼠注入的热路径。
import { spawn } from 'node:child_process';

// ---- 适用性判定（纯函数，按进程名；三态：uia / skip / unknown）----
// 白名单只放实测验证过的 UIA 富应用/标准控件宿主；微信等自绘/Electron/Chromium 一律 skip
// （它们没有可用的 UIA 树，试一次只会白等 + 双倍延迟，真机实测微信 4.x 空树）。
export const UIA_RICH_PATTERNS = [
  /^notepad$/i,            // 经典 + WinUI 记事本（本机实测 WinUI 11.x 树完整，含 MenuBar/Button）
  /^calc(ulator)?$/i,      // 计算器（UWP，需经 ApplicationFrameHost 宿主）
  /^applicationframehost$/i, // UWP 宿主（计算器/便笺/设置等真正的前台顶层窗口进程名）
  /^explorer$/i,
  /^charmap$/i,            // 字符映射表（经典 #32770，实测 Button 可 Invoke）
  /^wordpad$/i,
  /^mspaint$/i,
  /^winword$|^excel$|^powerpnt$/i, // Office 经典套件（UIA 树成熟）
  /^notepad\+\+$/i
];
// 明确没有可用 UIA 树的：微信（Qt 自绘，实测空树）、Electron/Chromium 系（自绘 + 树很浅）、
// 自绘终端。命中即 skip，不做任何探测（延迟增量为 0）。
export const UIA_NO_TREE_PATTERNS = [
  /^weixin$/i, /^wechat/i, /^wechatappex$/i,
  /chrome/i, /^msedge|^edge$/i, /electron/i, /chromium/i,
  /^code$|^cursor$|^windsurf$|^zed$/i, /^discord|^slack|^teams|^claude$/i,
  /^vscode$/i, /^finalcheck$/i, /^zcode$/i,
  /^mintty|^windows?terminal|^conhost|^wt$/i, /^jetbrains|^idea|^pycharm|^webstorm$/i,
  /^sublime_text$/i, /^obsidian$/i, /^notion$/i
];

/**
 * 某进程是否适合走 UIA 点击。
 * @param {string} processName 进程名（不带 .exe 也可）
 * @param {{ cache?: Map<string, 'uia'|'skip'> }} [opts] 按进程名缓存历史判定
 * @returns {'uia'|'skip'|'unknown'} 三态：白名单富应用 / 明确无树 / 未知（可探一次再缓存）
 * 纯函数：只读 cache，不写（写由 rememberUiaVerdict 负责，调用方决定何时学习）。
 */
export function uiaApplicability(processName, { cache } = {}) {
  const name = String(processName ?? '').trim().replace(/\.exe$/i, '').toLowerCase();
  if (!name) return 'skip';
  if (cache && cache.get(name)) return cache.get(name);
  if (UIA_NO_TREE_PATTERNS.some((re) => re.test(name))) return 'skip';
  if (UIA_RICH_PATTERNS.some((re) => re.test(name))) return 'uia';
  return 'unknown';
}

/** 学习一条判定（探测成功/失败后调用；只缓存确定结论）。 */
export function rememberUiaVerdict(cache, processName, verdict) {
  if (!(cache instanceof Map) || (verdict !== 'uia' && verdict !== 'skip')) return;
  const name = String(processName ?? '').trim().replace(/\.exe$/i, '').toLowerCase();
  if (name) cache.set(name, verdict);
}

// ---- 错误分类（回退表）----
// P0：只有「动作肯定没发生」的错误才允许回退 SendInput。invoke 已经发出后的超时/RPC 错误
// 绝不回退——那会变成双击（微信场景下就是重复发送消息）。
export const UIA_FALLBACK_CODES = new Set(['no-pattern', 'element-not-found', 'stale-element', 'ownership-mismatch']);
export function classifyUiaError(code) {
  const c = String(code ?? '').trim();
  const fallbackAllowed = UIA_FALLBACK_CODES.has(c);
  return { code: c || 'unknown', fallbackAllowed };
}

// ---- 哪些动作允许走 UIA（只做单击左键；不做拖拽/滚动/右键/中键/连击）----
export function uiaClickEligible(action) {
  return action === 'click' || action === 'left_click';
}

// ---- 响应解析（纯函数，方便直测协议）----
// 宿主回 `OK|name|controlType|pid|nwh|verified|pattern|visited` 或 `ERR|code|message`。
export function parseUiaResponse(line) {
  const text = String(line ?? '').trim();
  if (!text) return { ok: false, code: 'host-error', message: 'UIA 宿主返回空响应。' };
  if (text.startsWith('ERR|')) {
    const [code, ...rest] = text.slice(4).split('|');
    return { ok: false, code: code || 'host-error', message: rest.join('|') || code || 'UIA 失败' };
  }
  if (!text.startsWith('OK|')) return { ok: false, code: 'host-error', message: 'UIA 宿主返回了未知响应。' };
  // ⚠️ 不能跳过第一段：控件名可能为空（WinUI 的 MenuItem name=""），`OK||MenuItem|…` 的第一段就是空串。
  // 按位置取字段（C# 侧已把 '|' 替换成空格，字段内不会再有分隔符）。
  const parts = text.slice(3).split('|');
  return {
    ok: true,
    element: {
      name: String(parts[0] ?? '').slice(0, 200),
      controlType: String(parts[1] ?? ''),
      pid: Number(parts[2]) || 0,
      nativeWindowHandle: Number(parts[3]) || 0,
      hostVerified: parts[4] === '1',
      pattern: String(parts[5] ?? ''),
      visited: Number(parts[6]) || 0
    }
  };
}

// ---- 常驻 PowerShell UIA 宿主 ----
const UIA_PS_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
# 与键鼠注入宿主同一套 DPI 纪律：UIA 的 BoundingRectangle 必须与 GetWindowRect 同在物理坐标空间，
# 否则截图坐标（物理）和 UIA 矩形（逻辑）会对不上，视觉上「点偏了」。
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class FcUiaDpi {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static void Configure() { try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { } }
}
"@
[FcUiaDpi]::Configure()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type -ReferencedAssemblies @('UIAutomationClient','UIAutomationTypes','WindowsBase') -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

public class FcUia {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  const uint GA_ROOT = 2;
  const int MAX_DEPTH = 14;
  const int NODE_BUDGET = 3000;

  static string SafeName(AutomationElement el) {
    try { string n = el.Current.Name; return n == null ? "" : n.Replace("|", " "); } catch { return ""; }
  }
  static string SafeClass(AutomationElement el) {
    try { return el.Current.ClassName ?? ""; } catch { return ""; }
  }
  static string SafeType(AutomationElement el) {
    try { return el.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); } catch { return ""; }
  }
  static int SafePid(AutomationElement el) { try { return el.Current.ProcessId; } catch { return 0; } }
  static long SafeNwh(AutomationElement el) { try { return (long)el.Current.NativeWindowHandle; } catch { return 0; } }
  static System.Windows.Rect SafeRect(AutomationElement el) { try { return el.Current.BoundingRectangle; } catch { return System.Windows.Rect.Empty; } }

  // 从目标窗口自己的 UIA 子树做几何包含命中（**不用 FromPoint**——它按 z-order 返回遮挡窗元素）。
  // 只下钻包含命中点的元素（点不在父元素矩形内时子元素不可能命中，剪枝后树再大也只走一条链）。
  static AutomationElement HitInSubtree(AutomationElement root, double px, double py, out int visited) {
    visited = 0;
    AutomationElement best = null;
    double bestArea = double.MaxValue;
    var stack = new Stack<AutomationElement>();
    stack.Push(root);
    while (stack.Count > 0 && visited < NODE_BUDGET) {
      AutomationElement el = stack.Pop();
      if (el == null) continue;
      visited++;
      System.Windows.Rect r = SafeRect(el);
      if (r.IsEmpty || r.Width <= 0 || r.Height <= 0) continue;
      bool inside = px >= r.X && px < r.X + r.Width && py >= r.Y && py < r.Y + r.Height;
      if (!inside) continue;
      double area = r.Width * r.Height;
      if (area < bestArea) { bestArea = area; best = el; }
      AutomationElement child = null;
      try { child = TreeWalker.ControlViewWalker.GetFirstChild(el); } catch { child = null; }
      int guard = 0;
      while (child != null && guard++ < 200) {
        stack.Push(child);
        try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); } catch { child = null; }
      }
    }
    return best;
  }

  // 归属断言（P0 R2/R3）：JS 侧不能用 C# 的 AssertPoint（UIA 绕过它），这里自行复刻 hwnd 归属——
  // 从元素沿 UIA 父链向上找**第一个**带 NativeWindowHandle 的祖先，它的 GA_ROOT 必须等于目标 hwnd。
  // 归属链实测（WinUI 记事本 File 菜单）：MenuItem(nwh=0) → MenuBar(0) → InputSiteWindowClass(329998,
  // root=658150) → ... → Notepad(658150) → #32769 桌面(root=0)。所以判定必须「就近取第一个非 0 祖先」，
  // 不能要求每一个祖先都相等（桌面那层 root=0 会让穿透恒失败——第一版就踩了这个）。
  // UWP 跨进程合法：元素 pid 可能是应用进程、顶层 hwnd 属 ApplicationFrameHost——按 hwnd 归属判，不按 pid 相等判。
  static bool OwnedBy(AutomationElement el, IntPtr target) {
    AutomationElement cur = el;
    for (int i = 0; i <= MAX_DEPTH && cur != null; i++) {
      long nwh = SafeNwh(cur);
      if (nwh != 0) {
        IntPtr h = new IntPtr(nwh);
        IntPtr root = GetAncestor(h, GA_ROOT);
        if (root == IntPtr.Zero) root = h;
        return root == target;
      }
      try { cur = TreeWalker.ControlViewWalker.GetParent(cur); } catch { cur = null; }
    }
    return false;
  }

  // 从命中元素沿祖先链（最多 6 层）找第一个可执行的控件。不是全树搜索，只是点击「向上冒泡」。
  static AutomationElement Actionable(AutomationElement hit, out string pattern) {
    pattern = "";
    AutomationElement cur = hit;
    for (int i = 0; i < 6 && cur != null; i++) {
      try { cur.GetCurrentPattern(InvokePattern.Pattern); pattern = "invoke"; return cur; } catch { }
      try { cur.GetCurrentPattern(SelectionItemPattern.Pattern); pattern = "select"; return cur; } catch { }
      try { cur.GetCurrentPattern(TogglePattern.Pattern); pattern = "toggle"; return cur; } catch { }
      try { cur = TreeWalker.ControlViewWalker.GetParent(cur); } catch { cur = null; }
    }
    return null;
  }

  public static string Probe(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return "ERR|element-not-found|window-closed";
    AutomationElement root;
    try { root = AutomationElement.FromHandle(h); } catch (Exception ex) { return "ERR|element-not-found|" + ex.GetType().Name; }
    if (root == null) return "ERR|element-not-found|no-uia-root";
    int visited = 0;
    var stack = new Stack<AutomationElement>();
    stack.Push(root);
    while (stack.Count > 0 && visited < 500) {
      AutomationElement el = stack.Pop();
      if (el == null) continue;
      visited++;
      AutomationElement child = null;
      try { child = TreeWalker.ControlViewWalker.GetFirstChild(el); } catch { child = null; }
      int guard = 0;
      while (child != null && guard++ < 200) {
        stack.Push(child);
        try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); } catch { child = null; }
      }
    }
    return "OK|" + SafeClass(root) + "|" + visited;
  }

  // 0.30.0（特性 3）：wait-for 的观测快照——枚举目标窗口子树里「有名字的元素」与「文本值」。
  // output: OK|alive=1|names=...|values=...（names/values 用 U+0001 分隔，避免与 '|' 衝突）
  public static string Observe(long hwnd, int maxNodes) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return "OK|alive=0|names=|values=";
    AutomationElement root;
    try { root = AutomationElement.FromHandle(h); } catch { return "OK|alive=0|names=|values="; }
    if (root == null) return "OK|alive=0|names=|values=";
    var names = new List<string>();
    var values = new List<string>();
    var stack = new Stack<AutomationElement>();
    stack.Push(root);
    int visited = 0;
    int budget = maxNodes > 0 ? maxNodes : 400;
    while (stack.Count > 0 && visited < budget) {
      AutomationElement el = stack.Pop();
      if (el == null) continue;
      visited++;
      string name = SafeName(el);
      if (name.Length > 0 && name.Length < 120) names.Add(name);
      // 文本值：ValuePattern 或 TextPattern 的当前值（后者取 DocumentRange 的文本，可能很长——截断）
      try {
        ValuePattern vp = (ValuePattern)el.GetCurrentPattern(ValuePattern.Pattern);
        string v = vp.Current.Value;
        if (v != null) values.Add(v.Length > 400 ? v.Substring(0, 400) : v);
      } catch { }
      try {
        TextPattern tp = (TextPattern)el.GetCurrentPattern(TextPattern.Pattern);
        string t = tp.DocumentRange.GetText(400);
        if (!string.IsNullOrEmpty(t)) values.Add(t);
      } catch { }
      AutomationElement child = null;
      try { child = TreeWalker.ControlViewWalker.GetFirstChild(el); } catch { child = null; }
      int guard = 0;
      while (child != null && guard++ < 200) {
        stack.Push(child);
        try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); } catch { child = null; }
      }
    }
    return "OK|alive=1|names=" + string.Join("", names.ToArray()) + "|values=" + string.Join("", values.ToArray());
  }

  public static string Invoke(long hwnd, int pid, int x, int y) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return "ERR|element-not-found|window-closed";
    uint actualPid;
    if (GetWindowThreadProcessId(h, out actualPid) == 0 || (pid != 0 && actualPid != (uint)pid)) {
      return "ERR|ownership-mismatch|pid-changed";
    }
    AutomationElement root;
    try { root = AutomationElement.FromHandle(h); } catch (Exception ex) { return "ERR|ownership-mismatch|" + ex.GetType().Name; }
    if (root == null) return "ERR|element-not-found|no-uia-root";

    int visited = 0;
    AutomationElement hit = HitInSubtree(root, x, y, out visited);
    if (hit == null) return "ERR|element-not-found|no-element-at-point";
    if (!OwnedBy(hit, h)) return "ERR|ownership-mismatch|element-outside-target";

    string pattern = "";
    AutomationElement target = Actionable(hit, out pattern);
    if (target == null) {
      return "ERR|no-pattern|hit=" + SafeType(hit) + " visited=" + visited;
    }
    if (!OwnedBy(target, h)) return "ERR|ownership-mismatch|target-outside-window";

    string head = "OK|" + SafeName(target) + "|" + SafeType(target) + "|" + SafePid(target) + "|" +
      SafeNwh(target) + "|1|" + pattern + "|" + visited;
    bool started = false;
    try {
      if (pattern == "invoke") {
        InvokePattern p = (InvokePattern)target.GetCurrentPattern(InvokePattern.Pattern);
        started = true;
        p.Invoke();
      } else if (pattern == "select") {
        SelectionItemPattern p = (SelectionItemPattern)target.GetCurrentPattern(SelectionItemPattern.Pattern);
        started = true;
        p.Select();
      } else {
        TogglePattern p = (TogglePattern)target.GetCurrentPattern(TogglePattern.Pattern);
        started = true;
        p.Toggle();
      }
      return head;
    } catch (ElementNotAvailableException) {
      // 元素在调用途中消失：invoke 已发出 → 结果未知，绝不回退（会双击）
      return started ? "ERR|invoke-rpc-error|element-vanished-after-invoke" : "ERR|stale-element|element-vanished";
    } catch (COMException ex) {
      return "ERR|" + (started ? "invoke-rpc-error" : "com-error") + "|" + ex.Message.Replace("|", " ");
    } catch (InvalidOperationException ex) {
      return "ERR|no-pattern|" + ex.Message.Replace("|", " ");
    } catch (Exception ex) {
      return "ERR|" + (started ? "invoke-rpc-error" : "com-error") + "|" + ex.GetType().Name + ":" + ex.Message.Replace("|", " ");
    }
  }
}
"@
Write-Output "READY|1"
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq "") { continue }
  try {
    $cmd = $line | ConvertFrom-Json
    switch ($cmd.op) {
      "probe" { Write-Output ([FcUia]::Probe([long]$cmd.hwnd)) }
      "invoke" { Write-Output ([FcUia]::Invoke([long]$cmd.hwnd, [int]$cmd.pid, [int]$cmd.x, [int]$cmd.y)) }
      "observe" { Write-Output ([FcUia]::Observe([long]$cmd.hwnd, [int]$cmd.maxNodes)) }
      default { Write-Output ("ERR|host-error|unknown op: " + $cmd.op) }
    }
  } catch {
    Write-Output ("ERR|host-error|" + $_.Exception.GetBaseException().Message.Replace("|", " "))
  }
}
`;

let uiaProc = null;
let uiaReady = null;
let uiaStartup = null;      // { resolve, reject }：READY 行的等待者
let uiaStartupPromise = null; // startUiaProc 的返回 promise（幂等启动用）
let uiaPending = null;
const uiaQueue = [];
let uiaDisconnected = false;

function stopUiaProc(child, error) {
  if (uiaProc !== child) return;
  uiaProc = null;
  uiaReady = null;
  uiaStartup?.reject(error);
  uiaStartup = null;
  uiaPending?.reject(error);
  uiaPending = null;
  for (const command of uiaQueue.splice(0)) command.reject(error);
  try { child.kill(); } catch { /* 已退出 */ }
}

function startUiaProc(timeoutMs) {
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', UIA_PS_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  uiaProc = child;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => stopUiaProc(child, new Error('UIA 宿主启动超时')), timeoutMs);
    uiaStartup = {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    };
  });
  let buf = '';
  let startupError = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    if (uiaProc !== child) return;
    buf += data;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) handleUiaLine(line.trim());
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => { if (uiaStartup) startupError = (startupError + data).slice(-2000); });
  child.stdin.on('error', (error) => stopUiaProc(child, error));
  child.on('error', (error) => stopUiaProc(child, error));
  child.on('close', () => stopUiaProc(child, new Error(startupError.trim() || 'UIA 宿主已退出')));
  return promise;
}

function handleUiaLine(line) {
  if (!line) return;
  if (line.startsWith('READY|') && uiaStartup) {
    uiaReady = { ready: true };
    uiaStartup.resolve(uiaReady);
    uiaStartup = null;
    return;
  }
  const current = uiaPending;
  if (!current) return;
  uiaPending = null;
  current.resolve(line);
  nextUia();
}

function nextUia() {
  if (uiaPending || !uiaQueue.length) return;
  uiaPending = uiaQueue.shift();
  uiaProc.stdin.write(uiaPending.json + '\n');
}

function sendUia(cmd) {
  return new Promise((resolve, reject) => {
    if (!uiaProc || !uiaReady) { reject(new Error('UIA 宿主未就绪')); return; }
    // 与键鼠宿主同一纪律：stdin 只发 ASCII（中文标题/元素名可能出现在参数里的情况仍然安全）
    const json = JSON.stringify(cmd).replace(/[^\x00-\x7F]/g, (c) =>
      '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
    uiaQueue.push({ json, resolve, reject });
    nextUia();
  });
}

async function ensureUiaReady({ timeoutMs = 15000 } = {}) {
  if (uiaReady) return uiaReady;
  if (uiaDisconnected) throw new Error('UIA 宿主不可用');
  if (!uiaStartupPromise) uiaStartupPromise = startUiaProc(timeoutMs).finally(() => { uiaStartupPromise = null; });
  return uiaStartupPromise;
}

/** 探测目标窗口是否有可用 UIA 树（未知进程学习用；约 50ms）。 */
export async function uiaProbe(hwnd) {
  try {
    await ensureUiaReady();
    const line = await withTimeout(sendUia({ op: 'probe', hwnd: Number(hwnd) }), 8000);
    const parsed = parseUiaResponse(line);
    if (parsed.ok) {
      const parts = String(line).slice(3).split('|');
      return { ok: true, className: String(parts[0] ?? ''), descendants: Number(parts[1]) || 0 };
    }
    return { ok: false, code: parsed.code, message: parsed.message };  } catch (error) {
    uiaDisconnected = true;
    return { ok: false, code: error?.message === 'timeout' ? 'timeout' : 'host-error', message: String(error?.message || error) };
  }
}

/**
 * 在被遮挡的目标窗口上走 UIA 直接执行「左键单击」。
 * 不依赖像素可见性：目标窗口 FromHandle → 自己的 UIA 子树里几何命中 → 归属断言 → Invoke。
 * @returns {Promise<{ok:true, element:{...}} | {ok:false, code:string, message:string}>}
 */
export async function uiaInvokeAt({ hwnd, pid, x, y }) {
  const h = Number(hwnd);
  if (!Number.isSafeInteger(h) || h <= 0) return { ok: false, code: 'element-not-found', message: 'bad hwnd' };
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, code: 'element-not-found', message: 'bad point' };
  try {
    await ensureUiaReady();
    // 8000ms 覆盖「大 UIA 树遍历 + 目标应用无响应」；超时视为 invoke 可能已发出 → 非回退错误
    const line = await withTimeout(sendUia({ op: 'invoke', hwnd: h, pid: Number(pid) || 0, x: Math.round(x), y: Math.round(y) }), 8000);
    return parseUiaResponse(line);
  } catch (error) {
    uiaDisconnected = true;
    return { ok: false, code: String(error?.message) === 'timeout' ? 'timeout' : 'host-error', message: String(error?.message || error) };
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/** 0.30.0（特性 3）：wait-for 观测快照。返回 { ok, windowAlive, elements, values }。 */
export async function uiaObserve(hwnd, { maxNodes = 400 } = {}) {
  try {
    await ensureUiaReady();
    const line = await withTimeout(sendUia({ op: 'observe', hwnd: Number(hwnd), maxNodes }), 8000);
    const text = String(line ?? '');
    if (!text.startsWith('OK|')) return { ok: false, code: 'host-error', message: text || '空响应' };
    const parts = text.slice(3).split('|');
    const alive = parts[0] === 'alive=1';
    const namesRaw = parts.find((p) => p.startsWith('names='));
    const valuesRaw = parts.find((p) => p.startsWith('values='));
    const split = (raw) => (raw ? raw.slice(raw.indexOf('=') + 1).split('').filter(Boolean) : []);
    return { ok: true, windowAlive: alive, elements: split(namesRaw), values: split(valuesRaw) };
  } catch (error) {
    return { ok: false, code: String(error?.message) === 'timeout' ? 'timeout' : 'host-error', message: String(error?.message || error) };
  }
}

export function shutdownUia() {
  if (uiaProc) {
    const child = uiaProc;
    uiaDisconnected = true;
    stopUiaProc(child, new Error('UIA 宿主已关闭'));
  }
}

/** 测试用：重置宿主与断连标记（不杀正在跑的进程时也安全）。 */
export function resetUiaForTests() {
  shutdownUia();
  uiaDisconnected = false;
}
