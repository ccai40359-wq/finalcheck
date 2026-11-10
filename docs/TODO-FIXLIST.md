# 三轮修复清单（进行中 · 主会话接续用）

状态：已修 = bin 落穿（重写为 else-if）、S7/S8 降 check 级、gate.mjs 正则+runTests:false、bin --no-tests、q1 双斜杠/根路径/证据尾部、audit excl 归一。
**待修（下个接续回合做，全部在 src/download-gate.mjs）**：

1. ✅ **P0-2 npx -p 绕过**（已修：collectNpxTargets 收集全流 -p/--package 值形式与 = 形式；tests 固化 4 断言）
2. ✅ P1#5 旗标前置（已修：整条 token 流 findIndex 识别 INSTALL_SUBS，再从其后收集位置参数）
3. ✅ P1#6 `npm exec foo` / `npm x foo` 等价 npx（已修：head 为 npm 且 tokens[1]∈{exec,x} 走 collectNpxTargets）
4. ✅ P1#7 COMMON_HOSTS 子串绕过（已修：`host===w || host.endsWith('.'+w)`，白名单同步升级为注册域名 npmjs.org/github.com/…，否则 registry.npmjs.org 会被误报）
5. P2#15 yarn/pnpm/bun 变体：head 小写化 + 客户端集合扩展（可选，未做）
6. ✅ 修完跑：npm test 全绿（61 通过 0 红，新增 4 个绕过用例）+ scan-download 复测正常 + benchmark 复跑（数字见本轮报告）

然后：规格 §8 销账 + 交付总结 + 更新记忆 ai-code-security-reviewer-idea.md。
