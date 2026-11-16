// A GUI Electron runner has no console. CREATE_NO_WINDOW on its parent shell
// cannot provide one. Allocate a real console with SW_HIDE in STARTUPINFO *before*
// loading the vendor runner; its restricted children can then inherit it.
// Keep all token, ACL, job-object and child-process handling in the vendor runner.
import koffi from 'koffi';
import { pathToFileURL } from 'node:url';

try {
  const kernel = koffi.load('kernel32.dll');
  const getStartupInfo = kernel.func('void __stdcall GetStartupInfoW(void *)');
  const getConsoleWindow = kernel.func('void * __stdcall GetConsoleWindow()');
  const allocConsole = kernel.func('int __stdcall AllocConsole()');
  const freeConsole = kernel.func('int __stdcall FreeConsole()');
  const getStdHandle = kernel.func('void * __stdcall GetStdHandle(int)');
  const setStdHandle = kernel.func('int __stdcall SetStdHandle(int, void *)');
  const getLastError = kernel.func('uint32_t __stdcall GetLastError()');
  const isVisible = koffi.load('user32.dll').func('int __stdcall IsWindowVisible(void *)');
  // STARTUPINFOW x64: dwFlags at 60, wShowWindow at 64. The app launches us
  // with windowsHide:true (STARTF_USESHOWWINDOW, SW_HIDE). Reject other launchers
  // rather than briefly creating a visible window and hiding it afterwards.
  if (process.arch !== 'x64') throw new Error('hidden console requires Windows x64');
  const startup = Buffer.alloc(104);
  getStartupInfo(startup);
  if (!(startup.readUInt32LE(60) & 1) || startup.readUInt16LE(64) !== 0) {
    throw new Error('hidden console requires STARTF_USESHOWWINDOW/SW_HIDE');
  }
  const handles = [-10, -11, -12].map((kind) => [kind, getStdHandle(kind)]);
  // Never hide or reuse a user-owned console. AllocConsole honours the hidden
  // startup state, so there is no ShowWindow-after-allocation flash race.
  // CREATE_NO_WINDOW console-subsystem hosts may be attached without an HWND.
  // Detach unconditionally; having no console is harmless here.
  freeConsole();
  if (!allocConsole()) throw new Error(`AllocConsole failed (${getLastError()})`);
  if (!getConsoleWindow() || isVisible(getConsoleWindow())) throw new Error('console was not created hidden');
  // AllocConsole replaces Win32 standard handles. Preserve Node's original
  // inherited pipes/NUL handles for the vendor's stdio:inherit path.
  for (const [kind, handle] of handles) {
    if (!setStdHandle(kind, handle)) throw new Error(`SetStdHandle failed (${getLastError()})`);
  }
  const runner = process.argv.splice(2, 1)[0];
  if (!runner) throw new Error('missing vendor runner');
  await import(pathToFileURL(runner).href);
} catch (error) {
  process.stderr.write(`windows-acl-run: ${error?.message || String(error)}\n`);
  process.exitCode = 127;
}
