// slash 菜单现状探针：直接调 finalcheck:skills:list 的真实 handler，把顺序与描述打印出来。
// 用途：排序/描述这类"看起来对但读不到顺序"的问题，必须看真实输出，不能靠读代码猜。
// 用法：node scripts/probe-slash-menu-order.mjs
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const handlers = new Map();
const ipcMain = {
  handle(ch, fn) { handlers.set(ch, fn); },
  removeHandler(ch) { handlers.delete(ch); }
};

const { registerSystemIpc } = await import(pathToFileURL(path.join(root, 'desktop/src/main/ipc/ipc-system.mjs')).href);
registerSystemIpc({
  ipcMain,
  getWin: () => null,
  engineUrl: (rel) => pathToFileURL(path.join(root, rel)).href,
  store: {},
  getHooksConfig: () => null,
  sessionProjectPathOf: () => '',
  sessionUsage: new Map()
});

const list = await handlers.get('finalcheck:skills:list')({ sender: null });
console.log('total:', list.length);
const CMD = [
  { name: 'compact' }, { name: 'wake' }, { name: 'workflow' }
];
console.log('\n== 菜单实际顺序（前面 3 条是渲染层拼进去的命令） ==');
CMD.forEach((c, i) => console.log(`${String(i + 1).padStart(3)}. /${c.name}`));
list.forEach((x, i) => {
  console.log(`${String(i + 4).padStart(3)}. /${x.name}  [id=${x.id}]  descZh=${JSON.stringify(String(x.description || '').slice(0, 60))}  descEn=${JSON.stringify(String(x.descriptionEn || '').slice(0, 60))}`);
});

console.log('\n== 有问题的条目 ==');
for (const x of list) {
  const d = String(x.description || '');
  if (!d || d === '>' || d === '|' || d.length < 6) console.log('BAD-DESC', x.name, JSON.stringify(d));
  if (!String(x.descriptionEn || '').trim()) console.log('NO-EN   ', x.name);
}
