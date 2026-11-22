// Resolve only the native dependencies of the isolated computer-use instance.
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('computer-use.mjs?regression=') &&
      ['electron', './desktop-input-win.mjs', './uia-adapter.mjs'].includes(specifier)) {
    return { url: import.meta.url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export { classifyUiaError, rememberUiaVerdict, shutdownUia, uiaApplicability, uiaClickEligible }
  from '../../desktop/src/main/uia-adapter.mjs';

const bounds = { x: 0, y: 0, width: 300, height: 200 };
export const original = { hwnd: 11, pid: 12, process: 'notepad', title: 'Draft', bounds, focusHwnd: 13 };
export const other = { ...original, hwnd: 21, pid: 22, process: 'calc' };
export const host = {};
export function reset() {
  Object.assign(host, { target: original, foreground: original, blocker: null, calls: [], onFocus: null,
    invokeResult: { ok: true, element: { name: 'Button', hostVerified: true } } });
}
export const screen = { getPrimaryDisplay: () => ({ id: 1, bounds }), dipToScreenRect: (_, rect) => rect };
export const nativeImage = {};
const image = { isEmpty: () => false, getSize: () => bounds, toPNG: () => Buffer.from('png'), toJPEG: () => Buffer.from('jpg') };
export const desktopCapturer = { getSources: async ({ types }) => [{
  id: types.includes('window') ? 'window:11:0' : 'screen:1:0', display_id: '1', thumbnail: image
}] };
export const inputSupported = () => true;
export const ensureInputReady = async () => {};
export const desktopState = async () => ({ foreground: host.foreground, primaryScreen: bounds, virtualScreen: bounds, physicalCoordinates: true });
export const windowInfo = async () => host.target;
export async function focusWindow() {
  host.calls.push('focus');
  host.foreground = host.target;
  host.onFocus?.();
}
export const windowAtPoint = async () => host.blocker || host.target;
export const click = async () => { host.calls.push('click'); };
export async function uiaInvokeAt() {
  host.calls.push('invoke');
  return host.invokeResult;
}
export const uiaObserve = async () => host.observation;
