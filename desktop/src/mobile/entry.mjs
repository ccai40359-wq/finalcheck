// 手机端入口：先配对 + 连上事件流，再装桌面端 preload（得到 window.finalcheck），最后挂桌面端界面。
// __FC_PRELOAD__ / __FC_MAIN__ 由 scripts/build-app.mjs 换成桌面源码里的真实路径。
// 必须和 preload 走同一个说明符（'electron'），否则打包出两份桥：一份连着事件流、一份挂着监听器，事件永远到不了界面
import { ready } from 'electron';
import './mobile.css';
import './mobile-shell.mjs';

await ready();
await import('__FC_PRELOAD__');
await import('__FC_MAIN__');
