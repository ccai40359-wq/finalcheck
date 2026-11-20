// Windows 桌面输入注入（2026-11-21）
//
// 为什么这样实现：Electron 本身只能截屏（desktopCapturer），没有任何鼠标/键盘注入能力。
// 官方推荐的是 Win32 SendInput（不是老的 mouse_event，因为后者受鼠标加速/指针精度影响、
// 且不支持绝对坐标的精确语义）。为了不引入 robotjs/nut-js 这类原生模块（要编译、要 ABI 匹配、
// 打包后还要带 .node 文件），这里用 PowerShell 的 Add-Type 把调用封装进一个常驻子进程，
// 走 stdin/stdout 一行一条 JSON 命令。
//
// 常驻原因：每次 spawn powershell 要 1-2 秒（进程启动 + JIT），模型一次任务要几十步操作，
// 每步都等 2 秒不可用。所以进程只起一次，之后每条命令几十毫秒。
import { spawn } from 'node:child_process';


const PS_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.Windows.Forms','System.Drawing') -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FcCu {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);

  // SendInput：绝对坐标用 0..65535 归一化（跨多显示器），标志位含 MOVE|ABSOLUTE|VIRTUALDESK
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);

  const uint T_MOUSE = 0, T_KEY = 1;
  const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040, WHEEL = 0x0800, HWHEEL = 0x01000;
  const uint ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
  const uint KEYUP = 0x0002, UNICODE = 0x0004;

  static int SW, SH;

  public static void SetVirtualScreen(int w, int h) { SW = w; SH = h; }

  static void Mouse(uint flags, int dx, int dy, uint data) {
    var inp = new INPUT { type = T_MOUSE };
    inp.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
    SendInput(1, new[] { inp }, Marshal.SizeOf(typeof(INPUT)));
  }

  // 绝对移动：x/y 是屏幕像素（虚拟桌面坐标），转成 0..65535
  public static void MoveAbs(int x, int y) {
    int nx = SW > 1 ? (int)((x * 65535L) / (SW - 1)) : 0;
    int ny = SH > 1 ? (int)((y * 65535L) / (SH - 1)) : 0;
    Mouse(MOVE | ABSOLUTE | VIRTUALDESK, nx, ny, 0);
  }

  public static void Click(int x, int y, string button, int count) {
    MoveAbs(x, y);
    System.Threading.Thread.Sleep(15);
    uint down = LEFTDOWN, up = LEFTUP;
    if (button == "right") { down = RIGHTDOWN; up = RIGHTUP; }
    else if (button == "middle") { down = MIDDLEDOWN; up = MIDDLEUP; }
    for (int i = 0; i < count; i++) {
      Mouse(down, 0, 0, 0);
      System.Threading.Thread.Sleep(20);
      Mouse(up, 0, 0, 0);
      if (i + 1 < count) System.Threading.Thread.Sleep(80);
    }
  }

  public static void Drag(int x1, int y1, int x2, int y2) {
    MoveAbs(x1, y1);
    System.Threading.Thread.Sleep(30);
    Mouse(LEFTDOWN, 0, 0, 0);
    System.Threading.Thread.Sleep(60);
    // 分几步移动，很多应用要看到连续 move 才认拖拽
    for (int i = 1; i <= 8; i++) {
      int mx = x1 + (x2 - x1) * i / 8;
      int my = y1 + (y2 - y1) * i / 8;
      MoveAbs(mx, my);
      System.Threading.Thread.Sleep(20);
    }
    System.Threading.Thread.Sleep(40);
    Mouse(LEFTUP, 0, 0, 0);
  }

  public static void Scroll(int x, int y, string dir, int amount) {
    if (x >= 0 && y >= 0) { MoveAbs(x, y); System.Threading.Thread.Sleep(10); }
    int n = amount == 0 ? 1 : Math.Min(Math.Abs(amount), 30);
    for (int i = 0; i < n; i++) {
      if (dir == "left" || dir == "right") {
        // 水平滚轮用 HWHEEL：正数往右，负数往左
        uint data = dir == "right" ? 120u : 0xFFFFFF88u; // -120 的 uint 形态
        Mouse(HWHEEL, 0, 0, data);
      } else {
        uint data = dir == "up" ? 120u : 0xFFFFFF88u;
        Mouse(WHEEL, 0, 0, data);
      }
      System.Threading.Thread.Sleep(40);
    }
  }

  public static void Key(string keyName, int repeat) {
    // System.Windows.Forms.SendKeys 的写法更可读（^%+ 修饰），但它不能发裸 VK；这里用 SendKeys
    var sb = new StringBuilder();
    for (int i = 0; i < repeat; i++) sb.Append(keyName);
    System.Windows.Forms.SendKeys.SendWait(sb.ToString());
  }

  public static void TypeText(string text) {
    // 走 UNICODE 注入，避免 SendKeys 对 + ^ % { } 等字符的特殊含义
    foreach (char c in text) {
      var inp = new INPUT { type = T_KEY };
      inp.u.ki = new KEYBDINPUT { wVk = 0, wScan = (ushort)c, dwFlags = UNICODE, time = 0, dwExtraInfo = IntPtr.Zero };
      SendInput(1, new[] { inp }, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(2);
      var up = new INPUT { type = T_KEY };
      up.u.ki = new KEYBDINPUT { wVk = 0, wScan = (ushort)c, dwFlags = UNICODE | KEYUP, time = 0, dwExtraInfo = IntPtr.Zero };
      SendInput(1, new[] { up }, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(2);
    }
  }

  public static string ForegroundInfo() {
    IntPtr h = GetForegroundWindow();
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    uint pid = 0; GetWindowThreadProcessId(h, out pid);
    try {
      var p = System.Diagnostics.Process.GetProcessById((int)pid);
      return h.ToInt64() + "|" + p.ProcessName + "|" + sb.ToString();
    } catch { return h.ToInt64() + "||" + sb.ToString(); }
  }

  public static string CursorPos() {
    POINT p; GetCursorPos(out p);
    return p.X + "|" + p.Y;
  }
}
"@

# 虚拟桌面尺寸（多显示器）
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
[FcCu]::SetVirtualScreen($vs.Width, $vs.Height)
Write-Output "READY|$($vs.Width)|$($vs.Height)|$($vs.X)|$($vs.Y)"

# 主循环：一行一条 JSON
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq "") { continue }
  try {
    $cmd = $line | ConvertFrom-Json
    switch ($cmd.op) {
      "fg"      { Write-Output ("OK|" + [FcCu]::ForegroundInfo()) }
      "cursor"  { Write-Output ("OK|" + [FcCu]::CursorPos()) }
      "move"    { [FcCu]::MoveAbs([int]$cmd.x, [int]$cmd.y); Write-Output "OK|" }
      "click"   { [FcCu]::Click([int]$cmd.x, [int]$cmd.y, [string]$cmd.button, [int]$cmd.count); Write-Output "OK|" }
      "drag"    { [FcCu]::Drag([int]$cmd.x1, [int]$cmd.y1, [int]$cmd.x2, [int]$cmd.y2); Write-Output "OK|" }
      "scroll"  { [FcCu]::Scroll([int]$cmd.x, [int]$cmd.y, [string]$cmd.dir, [int]$cmd.amount); Write-Output "OK|" }
      "key"     { [FcCu]::Key([string]$cmd.keys, [int]$cmd.repeat); Write-Output "OK|" }
      "type"    { [FcCu]::TypeText([string]$cmd.text); Write-Output "OK|" }
      "focus"   {
        $h = [IntPtr][long]$cmd.hwnd
        [FcCu]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
        [FcCu]::SetForegroundWindow($h) | Out-Null
        Write-Output "OK|"
      }
      default   { Write-Output ("ERR|unknown op: " + $cmd.op) }
    }
  } catch {
    Write-Output ("ERR|" + $_.Exception.Message)
  }
}
`;

let proc = null;
let ready = null; // { w, h, x, y }
let pending = null; // 当前命令的回调（一条一条串行，因为注入是有序动作）
const queue = [];

function startProc() {
  if (proc) return;
  proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) handleLine(line.trim());
  });
  proc.stderr.on('data', () => { /* PS 的 warning 不影响协议 */ });
  proc.on('exit', () => { proc = null; ready = null; });
}

function handleLine(line) {
  if (!line) return;
  if (line.startsWith('READY|')) {
    const [, w, h, x, y] = line.split('|');
    ready = { width: Number(w), height: Number(h), x: Number(x), y: Number(y) };
    if (pending?.onReady) { const cb = pending.onReady; pending = null; cb(ready); }
    return;
  }
  const cur = pending;
  pending = null;
  if (!cur) return;
  if (line.startsWith('OK|')) cur.resolve(line.slice(3));
  else if (line.startsWith('ERR|')) cur.reject(new Error(line.slice(4)));
  else cur.resolve(line);
  next();
}

function next() {
  if (pending || !queue.length) return;
  pending = queue.shift();
  if (!proc) { pending.reject(new Error('输入注入进程未启动')); pending = null; return next(); }
  proc.stdin.write(JSON.stringify(pending.cmd) + '\n');
}

/** 启动（幂等）。返回虚拟桌面尺寸，给截图/坐标换算用 */
export async function ensureInputReady({ timeoutMs = 15000 } = {}) {
  startProc();
  if (ready) return ready;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending) { pending = null; reject(new Error('输入注入进程启动超时（PowerShell 初始化失败）')); }
    }, timeoutMs);
    pending = { cmd: null, onReady: (r) => { clearTimeout(timer); resolve(r); } };
  }).catch((e) => { throw e; });
  return ready;
}

function send(cmd) {
  return new Promise((resolve, reject) => {
    if (!proc || !ready) { reject(new Error('输入注入进程未就绪')); return; }
    queue.push({ cmd, resolve, reject });
    next();
  });
}

export async function foregroundInfo() {
  const r = await send({ op: 'fg' });
  const [hwnd, name, title] = r.split('|');
  return { hwnd: Number(hwnd) || null, process: name || '', title: title || '' };
}
export async function cursorPosition() {
  const r = await send({ op: 'cursor' });
  const [x, y] = r.split('|');
  return { x: Number(x), y: Number(y) };
}
export async function moveMouse(x, y) { await send({ op: 'move', x: Math.round(x), y: Math.round(y) }); }
export async function click(x, y, { button = 'left', count = 1 } = {}) {
  await send({ op: 'click', x: Math.round(x), y: Math.round(y), button, count });
}
export async function drag(x1, y1, x2, y2) {
  await send({ op: 'drag', x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2) });
}
export async function scroll(x, y, { dir = 'down', amount = 3 } = {}) {
  await send({ op: 'scroll', x: Math.round(x), y: Math.round(y), dir, amount });
}
export async function pressKey(keys, { repeat = 1 } = {}) { await send({ op: 'key', keys, repeat }); }
export async function typeText(text) { await send({ op: 'type', text: String(text) }); }
export async function focusWindow(hwnd) { await send({ op: 'focus', hwnd }); }

/** 关闭常驻进程（应用退出/测试收尾时调用） */
export function shutdownInput() {
  try { proc?.stdin.end(); } catch { /* 已关 */ }
  try { proc?.kill(); } catch { /* 已退 */ }
  proc = null; ready = null;
}

/** 平台支持判断：只有 Windows 有这套注入实现 */
export function inputSupported() {
  return process.platform === 'win32';
}
