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
# 中文编码（2026-11-21 真机踩到）：PowerShell 默认按系统 ANSI（中文 Windows = GBK）读写控制台，
# 输入输出里的中文都会变成乱码。stdin 侧由 JS 把所有非 ASCII 转成 \uXXXX（纯 ASCII 安全）；
# 输出侧（窗口标题可能含中文）在这里统一设成 UTF-8。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.Windows.Forms','System.Drawing') -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class FcCu {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public uint size, flags;
    public IntPtr active, focus, capture, menuOwner, moveSize, caret;
    public RECT caretRect;
  }

  public class Bounds {
    public int x { get; set; }
    public int y { get; set; }
    public int width { get; set; }
    public int height { get; set; }
    public bool Contains(int px, int py) { return px >= x && py >= y && (long)px - x < width && (long)py - y < height; }
    public bool Matches(Bounds b) { return b != null && x == b.x && y == b.y && width == b.width && height == b.height; }
  }

  public class Window {
    public long hwnd { get; set; }
    public uint pid { get; set; }
    public string process { get; set; }
    public string title { get; set; }
    public long focusHwnd { get; set; }
    public Bounds bounds { get; set; }
  }

  public class Guard {
    public long hwnd { get; set; }
    public uint pid { get; set; }
    public string title { get; set; }
    public long focusHwnd { get; set; }
    public Bounds windowBounds { get; set; }
    public Bounds virtualScreen { get; set; }
    public Bounds captureBounds { get; set; }
  }

  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);

  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx, dy;
    public uint mouseData, dwFlags, time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk, wScan;
    public uint dwFlags, time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);

  const uint T_MOUSE = 0, T_KEY = 1;
  const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040, WHEEL = 0x0800, HWHEEL = 0x01000;
  const uint EXTENDEDKEY = 0x0001, KEYUP = 0x0002, UNICODE = 0x0004, GA_ROOT = 2;

  static bool physicalCoordinates;

  public static void ConfigureDpi() {
    try { physicalCoordinates = SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero; }
    catch (EntryPointNotFoundException) { physicalCoordinates = false; }
  }

  public static Bounds VirtualBounds() {
    return new Bounds { x = GetSystemMetrics(76), y = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79) };
  }

  public static Bounds PrimaryBounds() {
    return new Bounds { x = 0, y = 0, width = GetSystemMetrics(0), height = GetSystemMetrics(1) };
  }

  public static bool PhysicalCoordinates() { return physicalCoordinates; }

  static Bounds WindowBounds(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return null;
    return new Bounds { x = r.Left, y = r.Top, width = r.Right - r.Left, height = r.Bottom - r.Top };
  }

  static string WindowTitle(IntPtr h) {
    var title = new StringBuilder(512);
    GetWindowText(h, title, title.Capacity);
    return title.ToString();
  }

  static bool ReadGuiThread(uint thread, out GUITHREADINFO info) {
    info = new GUITHREADINFO { size = (uint)Marshal.SizeOf(typeof(GUITHREADINFO)) };
    return GetGUIThreadInfo(thread, ref info);
  }

  static long FocusHandle(uint thread) {
    GUITHREADINFO info;
    return thread != 0 && ReadGuiThread(thread, out info) ? info.focus.ToInt64() : 0;
  }

  public static Window WindowInfo(IntPtr h) {
    uint pid;
    uint thread = GetWindowThreadProcessId(h, out pid);
    if (h == IntPtr.Zero || thread == 0 || pid == 0) return null;
    string processName = "";
    try {
      using (var p = System.Diagnostics.Process.GetProcessById((int)pid)) { processName = p.ProcessName; }
    } catch (ArgumentException) { return null; }
    catch (InvalidOperationException) { return null; }
    catch (Win32Exception) { return null; }
    return new Window {
      hwnd = h.ToInt64(), pid = pid, process = processName, title = WindowTitle(h),
      focusHwnd = FocusHandle(thread), bounds = WindowBounds(h)
    };
  }

  public static Window ForegroundInfo() { return WindowInfo(GetForegroundWindow()); }

  static void AssertForeground(Guard guard, bool keyboard, bool checkTitle) {
    if (guard == null) return;
    IntPtr foreground = GetForegroundWindow();
    uint pid;
    uint thread = GetWindowThreadProcessId(foreground, out pid);
    if (foreground.ToInt64() != guard.hwnd || pid != guard.pid || thread == 0 ||
        (checkTitle && WindowTitle(foreground) != guard.title) ||
        (guard.windowBounds != null && !guard.windowBounds.Matches(WindowBounds(foreground)))) {
      throw new InvalidOperationException("foreground-mismatch: The observed foreground window changed.");
    }
    if (keyboard) {
      long focused = FocusHandle(thread);
      uint focusPid;
      var focusWindow = new IntPtr(focused);
      GetWindowThreadProcessId(focusWindow, out focusPid);
      if (focused == 0 || focused != guard.focusHwnd || focusPid != guard.pid ||
          GetAncestor(focusWindow, GA_ROOT).ToInt64() != guard.hwnd) {
        throw new InvalidOperationException("foreground-mismatch: The observed keyboard focus changed.");
      }
    }
    if (guard.captureBounds != null && (!physicalCoordinates || !guard.captureBounds.Matches(PrimaryBounds()) ||
        !guard.virtualScreen.Matches(VirtualBounds()))) {
      throw new InvalidOperationException("screenshot-required: Display geometry changed.");
    }
  }

  static void AssertPoint(Guard guard, int x, int y) {
    if (guard == null) return;
    if (!guard.captureBounds.Contains(x, y)) {
      throw new InvalidOperationException("foreground-mismatch: The pointer is outside the observed display.");
    }
    GUITHREADINFO info;
    if (!ReadGuiThread(0, out info) ||
        (info.capture != IntPtr.Zero && GetAncestor(info.capture, GA_ROOT).ToInt64() != guard.hwnd)) {
      throw new InvalidOperationException("foreground-mismatch: Another window may be receiving mouse input.");
    }
    IntPtr window = WindowFromPoint(new POINT { X = x, Y = y });
    if (window == IntPtr.Zero || GetAncestor(window, GA_ROOT).ToInt64() != guard.hwnd) {
      throw new InvalidOperationException("foreground-mismatch: The point is outside the observed foreground window.");
    }
  }

  static POINT ReadCursor() {
    POINT p;
    if (!GetCursorPos(out p)) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetCursorPos failed.");
    return p;
  }

  static void AssertCursor(Guard guard, int? x = null, int? y = null) {
    if (guard == null) return;
    POINT actual = ReadCursor();
    if (x.HasValue && (actual.X != x.Value || actual.Y != y.Value)) {
      throw new InvalidOperationException("foreground-mismatch: The pointer moved before input.");
    }
    AssertPoint(guard, actual.X, actual.Y);
  }

  static INPUT MouseEvent(uint flags, uint data = 0) {
    var input = new INPUT { type = T_MOUSE };
    input.u.mi = new MOUSEINPUT { mouseData = data, dwFlags = flags };
    return input;
  }

  static INPUT UnicodeEvent(char c, uint flags) {
    var input = new INPUT { type = T_KEY };
    input.u.ki = new KEYBDINPUT { wScan = c, dwFlags = flags };
    return input;
  }

  static void Submit(params INPUT[] events) {
    Submit(events, events.Length == 2 ? 1 : 0);
  }

  static void Submit(INPUT[] events, int downs) {
    int size = Marshal.SizeOf(typeof(INPUT));
    uint inserted = SendInput((uint)events.Length, events, size);
    if (inserted != events.Length) {
      int error = Marshal.GetLastWin32Error();
      int downCount = Math.Min((int)inserted, downs);
      int upCount = Math.Max(0, (int)inserted - downs);
      if (downCount > upCount) {
        var releases = new INPUT[downCount - upCount];
        Array.Copy(events, events.Length - downCount + upCount, releases, 0, releases.Length);
        SendInput((uint)releases.Length, releases, size);
      }
      throw new Win32Exception(error, "SendInput accepted " + inserted + " of " + events.Length + " events.");
    }
  }

  static void PositionCursor(int x, int y) {
    if (!SetCursorPos(x, y)) throw new Win32Exception(Marshal.GetLastWin32Error(), "SetCursorPos failed.");
  }

  public static void MoveAbs(int x, int y, Guard guard) {
    AssertForeground(guard, false, true);
    AssertPoint(guard, x, y);
    PositionCursor(x, y);
    AssertCursor(guard, x, y);
  }

  public static void Click(int x, int y, string button, int count, Guard guard) {
    MoveAbs(x, y, guard);
    uint down = LEFTDOWN, up = LEFTUP;
    if (button == "right") { down = RIGHTDOWN; up = RIGHTUP; }
    else if (button == "middle") { down = MIDDLEDOWN; up = MIDDLEUP; }
    for (int i = 0; i < count; i++) {
      AssertForeground(guard, false, true);
      AssertCursor(guard, x, y);
      Submit(MouseEvent(down), MouseEvent(up));
      if (i + 1 < count) System.Threading.Thread.Sleep(80);
    }
  }

  public static void Drag(int x1, int y1, int x2, int y2, Guard guard) {
    AssertForeground(guard, false, true);
    for (int i = 0; i <= 8; i++) AssertPoint(guard, x1 + (x2 - x1) * i / 8, y1 + (y2 - y1) * i / 8);
    MoveAbs(x1, y1, guard);
    AssertForeground(guard, false, true);
    AssertCursor(guard, x1, y1);
    Submit(MouseEvent(LEFTDOWN));
    try {
      System.Threading.Thread.Sleep(35);
      // 连续的移动让应用能识别拖拽。
      for (int i = 1; i <= 8; i++) {
        MoveAbs(x1 + (x2 - x1) * i / 8, y1 + (y2 - y1) * i / 8, guard);
        System.Threading.Thread.Sleep(20);
      }
    } finally {
      Submit(MouseEvent(LEFTUP));
    }
  }

  public static void Scroll(int? x, int? y, string dir, int amount, Guard guard) {
    if (x.HasValue && y.HasValue) MoveAbs(x.Value, y.Value, guard);
    int n = amount == 0 ? 1 : (int)Math.Min(Math.Abs((long)amount), 30);
    uint flag = dir == "left" || dir == "right" ? HWHEEL : WHEEL;
    uint data = dir == "right" || dir == "up" ? 120u : unchecked((uint)-120);
    for (int i = 0; i < n; i++) {
      AssertForeground(guard, false, true);
      AssertCursor(guard, x, y);
      Submit(MouseEvent(flag, data));
      if (i + 1 < n) System.Threading.Thread.Sleep(40);
    }
  }

  static readonly Dictionary<string, ushort> NamedKeys = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
    { "BACK", 0x08 }, { "BACKSPACE", 0x08 }, { "BS", 0x08 }, { "BKSP", 0x08 },
    { "TAB", 0x09 }, { "ENTER", 0x0D }, { "RETURN", 0x0D }, { "~", 0x0D },
    { "PAUSE", 0x13 }, { "BREAK", 0x13 }, { "CAPSLOCK", 0x14 },
    { "ESC", 0x1B }, { "ESCAPE", 0x1B }, { "SPACE", 0x20 },
    { "PGUP", 0x21 }, { "PAGEUP", 0x21 }, { "PRIOR", 0x21 },
    { "PGDN", 0x22 }, { "PAGEDOWN", 0x22 }, { "NEXT", 0x22 },
    { "END", 0x23 }, { "HOME", 0x24 }, { "LEFT", 0x25 }, { "UP", 0x26 },
    { "RIGHT", 0x27 }, { "DOWN", 0x28 }, { "PRTSC", 0x2C }, { "PRINTSCREEN", 0x2C },
    { "INS", 0x2D }, { "INSERT", 0x2D }, { "DEL", 0x2E }, { "DELETE", 0x2E },
    { "NUMLOCK", 0x90 }, { "SCROLLLOCK", 0x91 }
  };

  static InvalidOperationException InvalidKey() {
    return new InvalidOperationException("Provide one key or chord, such as Enter, Tab, Ctrl+S, ^s, or %{F4}. Use repeat from 1 to 100 for repeated presses.");
  }

  static ushort ModifierCode(string token) {
    switch (token.ToUpperInvariant()) {
      case "CTRL": case "CONTROL": case "^": return 0x11;
      case "ALT": case "%": return 0x12;
      case "SHIFT": case "+": return 0x10;
      default: return 0;
    }
  }

  static void AddModifier(List<ushort> keys, string token) {
    ushort modifier = ModifierCode(token);
    if (modifier == 0 || keys.Contains(modifier)) throw InvalidKey();
    keys.Add(modifier);
  }

  static ushort VirtualKey(string token) {
    if (token.Length >= 2 && token[0] == '{' && token[token.Length - 1] == '}') {
      token = token.Substring(1, token.Length - 2);
    }
    ushort value;
    if (NamedKeys.TryGetValue(token, out value)) return value;
    if (token.Length == 1) {
      char c = char.ToUpperInvariant(token[0]);
      if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
    }
    int function;
    if ((token.Length == 2 || token.Length == 3) && char.ToUpperInvariant(token[0]) == 'F' &&
        int.TryParse(token.Substring(1), out function) && function >= 1 && function <= 24) {
      return (ushort)(0x6F + function);
    }
    throw InvalidKey();
  }

  static INPUT VirtualKeyEvent(ushort code, bool release) {
    bool extended = (code >= 0x21 && code <= 0x28) || code == 0x2C || code == 0x2D || code == 0x2E || code == 0x90;
    var input = new INPUT { type = T_KEY };
    input.u.ki = new KEYBDINPUT { wVk = code, dwFlags = (extended ? EXTENDEDKEY : 0) | (release ? KEYUP : 0) };
    return input;
  }

  static INPUT[] GuardedKeyEvents(string specification) {
    var keys = new List<ushort>();
    string key = specification.Trim();
    if (key.Length == 0) throw InvalidKey();

    if ("^%+".IndexOf(key[0]) != -1) {
      int i = 0;
      while (i < key.Length && "^%+".IndexOf(key[i]) != -1) AddModifier(keys, key[i++].ToString());
      key = key.Substring(i);
    } else {
      string[] tokens = key.Split('+');
      for (int i = 0; i < tokens.Length - 1; i++) AddModifier(keys, tokens[i].Trim());
      key = tokens[tokens.Length - 1].Trim();
    }
    keys.Add(VirtualKey(key));

    var events = new INPUT[keys.Count * 2];
    for (int i = 0; i < keys.Count; i++) {
      events[i] = VirtualKeyEvent(keys[i], false);
      events[events.Length - 1 - i] = VirtualKeyEvent(keys[i], true);
    }
    return events;
  }

  public static void Key(string keyName, int repeat, Guard guard) {
    if (guard == null) {
      var keys = new StringBuilder();
      for (int i = 0; i < repeat; i++) keys.Append(keyName);
      System.Windows.Forms.SendKeys.SendWait(keys.ToString());
      return;
    }
    if (repeat < 1 || repeat > 100) throw InvalidKey();
    var events = GuardedKeyEvents(keyName);
    for (int i = 0; i < repeat; i++) {
      if (i > 0) System.Threading.Thread.Sleep(40);
      // 0.29.2：键盘动作入口不比 title（打字会加未保存脏标记 *，逐字符层本来就是 false）；
      // 窗口身份由 hwnd+pid 保证，键盘落点由 focus 复核保证。
      AssertForeground(guard, true, false);
      Submit(events, events.Length / 2);
    }
  }

  public static void TypeText(string text, Guard guard) {
    if (guard != null && (text.Length == 0 || text.Length > 4096)) throw new InvalidOperationException("Type accepts 1 to 4096 UTF-16 code units per action.");
    // 0.29.2：同上——入口不比 title；窗口身份 hwnd+pid，键盘落点 guard.focusHwnd。
    AssertForeground(guard, true, false);
    foreach (char c in text) {
      AssertForeground(guard, true, false);
      Submit(UnicodeEvent(c, UNICODE), UnicodeEvent(c, UNICODE | KEYUP));
    }
  }

  public static bool GuardedFocus(IntPtr target, uint expectedPid, string expectedTitle, Guard guard) {
    AssertForeground(guard, false, true);
    uint pid;
    if (GetWindowThreadProcessId(target, out pid) == 0 || pid != expectedPid || WindowTitle(target) != expectedTitle) {
      throw new InvalidOperationException("foreground-mismatch: The selected focus window changed.");
    }
    if (GetForegroundWindow() != target) SetForegroundWindow(target);
    return GetForegroundWindow() == target;
  }

  public static string CursorPos() {
    POINT p = ReadCursor();
    return p.X + "|" + p.Y;
  }
}
"@

[FcCu]::ConfigureDpi()
$vs = [FcCu]::VirtualBounds()
Write-Output "READY|$($vs.width)|$($vs.height)|$($vs.x)|$($vs.y)"

function ReadBounds($value) {
  if ($null -eq $value) { return $null }
  $bounds = New-Object 'FcCu+Bounds'
  $bounds.x = $value.x
  $bounds.y = $value.y
  $bounds.width = $value.width
  $bounds.height = $value.height
  return $bounds
}

function ReadGuard($value) {
  if ($null -eq $value) { return $null }
  $guard = New-Object 'FcCu+Guard'
  $guard.hwnd = $value.hwnd
  $guard.pid = $value.pid
  $guard.title = $value.title
  $guard.focusHwnd = $value.focusHwnd
  $guard.windowBounds = ReadBounds $value.windowBounds
  $guard.virtualScreen = ReadBounds $value.virtualScreen
  $guard.captureBounds = ReadBounds $value.captureBounds
  return $guard
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq "") { continue }
  try {
    $cmd = $line | ConvertFrom-Json
    $guard = ReadGuard $cmd.guard
    switch ($cmd.op) {
      "fg" {
        $state = @{
          foreground = [FcCu]::ForegroundInfo()
          virtualScreen = [FcCu]::VirtualBounds()
          primaryScreen = [FcCu]::PrimaryBounds()
          physicalCoordinates = [FcCu]::PhysicalCoordinates()
        }
        Write-Output ("OK|" + (ConvertTo-Json -InputObject $state -Depth 4 -Compress))
      }
      "window" {
        $window = [FcCu]::WindowInfo([IntPtr][long]$cmd.hwnd)
        Write-Output ("OK|" + (ConvertTo-Json -InputObject $window -Depth 4 -Compress))
      }
      "cursor" { Write-Output ("OK|" + [FcCu]::CursorPos()) }
      "move" { [FcCu]::MoveAbs([int]$cmd.x, [int]$cmd.y, $guard); Write-Output "OK|" }
      "click" { [FcCu]::Click([int]$cmd.x, [int]$cmd.y, [string]$cmd.button, [int]$cmd.count, $guard); Write-Output "OK|" }
      "drag" { [FcCu]::Drag([int]$cmd.x1, [int]$cmd.y1, [int]$cmd.x2, [int]$cmd.y2, $guard); Write-Output "OK|" }
      "scroll" { [FcCu]::Scroll($cmd.x, $cmd.y, [string]$cmd.dir, [int]$cmd.amount, $guard); Write-Output "OK|" }
      "key" { [FcCu]::Key([string]$cmd.keys, [int]$cmd.repeat, $guard); Write-Output "OK|" }
      "type" { [FcCu]::TypeText([string]$cmd.text, $guard); Write-Output "OK|" }
      "focus" {
        $h = [IntPtr][long]$cmd.hwnd
        if ($null -ne $guard) {
          [FcCu]::GuardedFocus($h, [uint32]$cmd.target.pid, [string]$cmd.target.title, $guard) | Out-Null
        } else {
          $fw = [FcCu]::GetForegroundWindow()
          $fwPid = [uint32]0
          $fwTid = [FcCu]::GetWindowThreadProcessId($fw, [ref]$fwPid)
          $myTid = [FcCu]::GetCurrentThreadId()
          [FcCu]::ShowWindow($h, 9) | Out-Null
          if ($fwTid -ne 0 -and $fwTid -ne $myTid -and [FcCu]::AttachThreadInput($myTid, $fwTid, $true)) {
            try {
              [FcCu]::BringWindowToTop($h) | Out-Null
              [FcCu]::SetForegroundWindow($h) | Out-Null
            } finally {
              [FcCu]::AttachThreadInput($myTid, $fwTid, $false) | Out-Null
            }
          } else {
            [FcCu]::SetForegroundWindow($h) | Out-Null
          }
        }
        $now = [FcCu]::GetForegroundWindow()
        Write-Output ("OK|" + $now.ToInt64() + "|" + ($now -eq $h).ToString().ToLowerInvariant())
      }
      default { Write-Output ("ERR|unknown op: " + $cmd.op) }
    }
  } catch {
    Write-Output ("ERR|" + $_.Exception.GetBaseException().Message)
  }
}
`;

let proc = null;
let ready = null;
let startup = null;
let pending = null;
const queue = [];

function stopProc(child, error) {
  if (proc !== child) return;
  proc = null;
  ready = null;
  startup?.reject(error);
  startup = null;
  pending?.reject(error);
  pending = null;
  for (const command of queue.splice(0)) command.reject(error);
  child.kill();
}

function startProc(timeoutMs) {
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  proc = child;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => stopProc(child, new Error('输入注入进程启动超时')), timeoutMs);
    startup = {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    };
  });

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    if (proc !== child) return;
    buf += data;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) handleLine(line.trim());
  });
  let startupError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => {
    if (startup) startupError = (startupError + data).slice(-3000);
  });
  child.stdin.on('error', (error) => stopProc(child, error));
  child.on('error', (error) => stopProc(child, error));
  child.on('close', () => stopProc(child, new Error(startupError.trim() || '输入注入进程已退出')));
  return promise;
}

let readyPromise = null;

function handleLine(line) {
  if (!line) return;
  if (line.startsWith('READY|') && startup) {
    const [, w, h, x, y] = line.split('|');
    ready = { width: Number(w), height: Number(h), x: Number(x), y: Number(y) };
    startup.resolve(ready);
    startup = null;
    return;
  }
  const current = pending;
  if (!current) return;
  pending = null;
  if (line.startsWith('OK|')) current.resolve(line.slice(3));
  else if (line.startsWith('ERR|')) current.reject(new Error(line.slice(4)));
  else current.reject(new Error('桌面输入进程返回了未知响应。'));
  next();
}

function next() {
  if (pending || !queue.length) return;
  pending = queue.shift();
  proc.stdin.write(pending.json + '\n');
}

/** 启动（幂等）。返回启动时的虚拟屏幕尺寸。 */
export async function ensureInputReady({ timeoutMs = 15000 } = {}) {
  if (ready) return ready;
  if (!readyPromise) {
    readyPromise = startProc(timeoutMs).finally(() => { readyPromise = null; });
  }
  return readyPromise;
}

function send(cmd) {
  return new Promise((resolve, reject) => {
    if (!proc || !ready) { reject(new Error('输入注入进程未就绪')); return; }
    // 向 PowerShell 发送 ASCII 安全的 JSON。
    const json = JSON.stringify(cmd).replace(/[^\x00-\x7F]/g, (c) =>
      '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
    queue.push({ json, resolve, reject });
    next();
  });
}

export async function desktopState() {
  return JSON.parse(await send({ op: 'fg' }));
}

export async function foregroundInfo() {
  return (await desktopState()).foreground ?? { hwnd: null, pid: null, process: '', title: '' };
}

export async function windowInfo(hwnd) {
  return JSON.parse(await send({ op: 'window', hwnd }));
}

export async function cursorPosition() {
  const r = await send({ op: 'cursor' });
  const [x, y] = r.split('|');
  return { x: Number(x), y: Number(y) };
}

export async function moveMouse(x, y, { guard } = {}) {
  await send({ op: 'move', x: Math.round(x), y: Math.round(y), guard });
}
export async function click(x, y, { button = 'left', count = 1, guard } = {}) {
  await send({ op: 'click', x: Math.round(x), y: Math.round(y), button, count, guard });
}
export async function drag(x1, y1, x2, y2, { guard } = {}) {
  await send({ op: 'drag', x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2), guard });
}
export async function scroll(x, y, { dir = 'down', amount = 3, guard } = {}) {
  const hasPoint = x != null && y != null && (guard || (x >= 0 && y >= 0));
  await send({ op: 'scroll', x: hasPoint ? Math.round(x) : null, y: hasPoint ? Math.round(y) : null, dir, amount, guard });
}
export async function pressKey(keys, { repeat = 1, guard } = {}) { await send({ op: 'key', keys, repeat, guard }); }
export async function typeText(text, { guard } = {}) { await send({ op: 'type', text: String(text), guard }); }

export async function focusWindow(hwnd, { target, guard } = {}) {
  const r = await send({ op: 'focus', hwnd, target, guard });
  const [nowHwnd, became] = r.split('|');
  const becameForeground = became === 'true';
  return { ok: becameForeground, hwnd: Number(nowHwnd) || null, becameForeground };
}

/** 关闭常驻进程（应用退出/测试收尾时调用） */
export function shutdownInput() {
  if (proc) stopProc(proc, new Error('桌面输入已关闭'));
}

export function inputSupported() {
  return process.platform === 'win32';
}
