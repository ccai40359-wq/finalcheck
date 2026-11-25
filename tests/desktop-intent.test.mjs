// 0.33.4 用户反馈三条：
//   ① 浏览器任务 AI 却去用桌面操控（computer_*，抢前台）——用户没要求操控电脑就不给
//   ② ESC 停止操控把整个任务、而且是所有会话的任务都停了——现在只停桌面操控，回合照常跑完，别的会话不受影响
//   ③ 计划审批卡的实时版没带 kind=plan，Markdown 原样露符号（渲染层，见 App.jsx onAskUser）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { desktopIntent, isDesktopTool } from '../desktop/src/main/desktop-intent.mjs';
import { startGateway } from '../scripts/sim/gateway.mjs';
import { createSimClient } from '../scripts/sim/client.mjs';

const u = (content) => ({ role: 'user', content });

test('desktopIntent：浏览器 / 网页任务不算；明确操控电脑或桌面软件才算；看最近 3 条；CU 会话进行中算', () => {
  for (const s of ['打开reddit，我登录', '帮我在浏览器里搜一下', '截个网页的图看看样式', '这个页面在小屏幕上乱了', '打开小红书发个帖子', 'take a screenshot of the page'])
    assert.equal(desktopIntent([u(s)]).allowed, false, s);
  for (const s of ['帮我操控电脑打开微信', '在 Word 里把标题加粗', '用 excel 打开这个表', '截个屏看看我桌面', '/computer-use 打开记事本', '帮我操作一下桌面软件'])
    assert.equal(desktopIntent([u(s)]).allowed, true, s);
  // 最近 3 条用户消息内提过就算（「继续」类跟进）
  assert.equal(desktopIntent([u('帮我操控电脑打开微信'), u('继续')]).allowed, true);
  assert.equal(desktopIntent([u('帮我操控电脑打开微信'), u('a'), u('b'), u('c')]).allowed, false);
  assert.equal(desktopIntent([u('继续')], { cuActive: true }).allowed, true);
  assert.equal(desktopIntent([u([{ type: 'text', text: '在微信里发消息' }])]).allowed, true, '多段 content');
  assert.ok(isDesktopTool('computer_action') && !isDesktopTool('browser_screenshot'));
});

test('全链路：没要求操控电脑 → schema 没有 computer_*、硬调被拒；ESC 只停桌面操控、回合照常完成、另一个会话不受影响', async () => {
  const toolLists = new Map(); // 用户消息 → 首个请求的工具名
  const toolResults = [];
  let simRef = null;
  let wxResults = 0;
  const gw = await startGateway({
    mode: 'script',
    respond: async (body, { kind }) => {
      if (kind !== 'main') return null;
      const users = body.messages.filter((m) => m.role === 'user');
      const q = String(users.at(-1)?.content || '');
      const last = body.messages[body.messages.length - 1];
      if (!toolLists.has(q)) toolLists.set(q, (body.tools || []).map((t) => t.function.name));
      if (q.includes('慢任务')) {
        // 另一个会话：慢慢跑，期间别的会话按了 ESC，它不能被中止
        if (last.role === 'tool') return { content: '慢任务完成。' };
        return { delayMs: 1500, toolCalls: [{ name: 'list_dir', args: {} }] };
      }
      if (last.role === 'tool') {
        toolResults.push(String(last.content));
        if (q.includes('微信')) wxResults += 1;
        if (q.includes('微信') && wxResults === 2) return { content: '已停止桌面操控，改用别的办法收尾。' };
        if (q.includes('微信')) {
          // 用户在操控期间按了 ESC
          await simRef.invoke('finalcheck:cu-stop');
          return { toolCalls: [{ name: 'computer_action', args: { action: 'key', keys: 'Enter' } }] };
        }
        return { content: '好的。' };
      }
      return { toolCalls: [{ name: 'computer_screenshot', args: {} }] };
    }
  });
  const sim = await createSimClient({ label: 'cu-intent', gateway: gw, config: { permissionMode: 'full' } });
  simRef = sim;
  try {
    // ① 浏览器任务：schema 里没有 computer_*；模型硬调 → cu-intent 拒绝
    const s1 = await sim.newSession();
    await sim.send(s1, '打开reddit，我登录');
    const tools1 = toolLists.get('打开reddit，我登录');
    assert.ok(tools1.includes('read_file') && !tools1.some((n) => n.startsWith('computer_')), '没要求操控电脑：schema 不含 computer_*');
    assert.match(toolResults[0], /没有要求操控电脑/);

    // ② 明确要操控电脑：schema 有 computer_*；操控中按 ESC → 后续 computer_* 被拒（cu-stopped），回合正常完成
    const s2 = await sim.newSession();
    const s3 = await sim.newSession();
    const slow = sim.send(s3, '慢任务：列一下目录');
    await new Promise((r) => setTimeout(r, 300));
    const r2 = await sim.send(s2, '帮我操控电脑打开微信');
    assert.ok(toolLists.get('帮我操控电脑打开微信').includes('computer_action'), '要求了操控电脑：schema 含 computer_*');
    assert.match(toolResults[2], /停止操控/, JSON.stringify(toolResults));
    assert.equal(r2.cancelled, false);
    assert.match(r2.answer, /改用别的办法收尾/, '按 ESC 后回合没被中止');
    const r3 = await slow;
    assert.equal(r3.cancelled, false, '别的会话的回合不受 ESC 影响');
    assert.match(r3.answer, /慢任务完成/);
  } finally {
    await sim.backend()?.shutdown?.();
    await sim.close();
    await gw.close?.();
  }
});

test('计划审批实时卡带上 kind（否则计划 Markdown 不渲染）', () => {
  const app = readFileSync(new URL('../desktop/src/renderer/App.jsx', import.meta.url), 'utf8');
  const block = app.slice(app.indexOf('y.onAskUser((p)'), app.indexOf('y.onAskUser((p)') + 1200);
  assert.match(block, /kind: String\(p\.kind\)/);
  const ask = readFileSync(new URL('../desktop/src/main/ask-user.mjs', import.meta.url), 'utf8');
  assert.match(ask, /kind: 'plan'|kind:\s*isPlan|\.\.\.\(isPlan/);
});
