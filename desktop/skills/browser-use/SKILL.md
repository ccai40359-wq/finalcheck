---
name: browser-use
description: Use when 操作网页：打开页面/点击/填表/读控制台/需要真实登录态。用户点名 /browser-use 或要求 AI 打开网址做验证/抓取/自动化时加载；桌面软件改用 /computer-use。
description_en: Automate web pages with the browser_* tools across three modes (private offscreen, persistent offscreen, CDP real Edge). Navigate returns a structural snapshot with refs; act only on the latest refs; pass observe:true to verify after clicks; check browser_console when a page misbehaves; use mode:real only when a site genuinely needs the user's real login.
---

# 网页操作（browser-use）

用 `browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type` 等工具操作网页。核心循环：**navigate 拿快照 → 用最新 ref 动作 → observe 验证 → 出问题查 console**。优先依赖**结构快照**（角色/名称/ref），像素截图只留给「需要看排版/给用户看」的场合。

## 三种模式（0.31.0）：先判断「这个站要不要登录态」

| 模式 | 宿主 | 存储 | 什么时候用 |
|---|---|---|---|
| ① 离屏无痕（**默认**） | FC 自己的离屏 Chromium | 内存，关窗即丢 | 绝大部分验证/抓取/无登录页面 |
| ② 离屏持久 | 同一个离屏窗口 | `persist:fc-browser-use` 写磁盘 | 用户要求「这个站要一直记住登录」且愿意写盘 |
| ③ CDP 接真 Edge | 用户真实 Edge（隔离 profile） | 独立 profile 落盘 | 站点**必须有真实登录态**才看得到内容（自己登录的账号、扫码站） |

**模式①②由设置决定，不用你操心**：默认无痕；用户在「设置 → 浏览器会话」里改成「长期保留」后，下一次 `browser_navigate` 自动生效（会把旧的离屏窗口关掉再按新 partition 重建——这是刻意行为，避免同进程出现两套 cookie）。你在工具结果里看到的 `policy` 就是本轮实际用的模式。

**模式③必须显式操作**（它跨进程、会用到用户真实登录态，不能默认开）：

1. `browser_connect_real(platforms: ["github"])` —— 连接或启动隔离 Edge（CDP **9224**，独立 profile）。
   首次启动窗口会出现在**前台**（方便用户扫码登录），这是刻意设计；之后所有 CDP 操作都**不抢前台**。
2. 让用户在那个 Edge 里把目标站登录好；用 `browser_login_state(platform)` 检查：
   `signed-in`（页面有已登录标识）/ `signed-out`（有登录墙）/ `unknown`（两类证据都缺或同时出现）/ `unavailable`（CDP 不通）。
3. 之后所有 `browser_*` 工具自动走真 Edge（ref 前缀是 `r1`、`r2`…；离屏模式的 ref 前缀是 `e…-…`）。
   要显式指定跑哪边，`browser_navigate` 传 `mode: "real"`。
4. 收尾用 `browser_disconnect_real()` —— **它只断开 CDP，不杀 Edge**，登录态留给下次。
   只有用户明确要求关闭浏览器时才传 `close_browser: true`。

**为什么不能拿真 Edge 当默认**：它会操作用户自己登录着的账号（点赞、发帖、改资料都是真实后果），而且窗口可见。
凡是「必须登录才看得到内容」以外的场景，一律用模式①。

## 标准循环（严格按顺序）

1. **打开页面**：`browser_navigate(url)`。默认同时返回页面结构快照和每个可操作元素的 `ref`——先读这个快照，不要凭空猜元素。模式①②是独立浏览器窗口，**不继承用户浏览器里的登录态**；需要登录就按上面的模式③走。
2. **用最新 ref 动作**：点击用 `browser_click(ref)`，输入用 `browser_type(ref, text)`。ref 必须来自**最近一次**快照——页面变过就先 `browser_snapshot` 刷新（可用 `query` 关键词缩小范围找元素）。
3. **验证变化**：预计点击会跳转/翻页/弹层时传 `observe: true`，同一次调用里拿点击后的新快照；或动作后自己再 `browser_snapshot`。输入完成后提交前建议快照确认填对了字段。
4. **页面不对先查 console**：元素找不到、点击没反应、白屏时调 `browser_console` 读最近 50 条控制台错误——JS 报错多半在这里。
5. **收尾**：临时验证完调 `browser_close` 关窗（模式①②）；模式③用 `browser_disconnect_real`，不要 `browser_close`。

## 边界与已知坑

- **ref 会失效，但有自动重绑**（模式①②）：页面重渲染（React/Vue 常态）会让旧 ref 持有的 DOM 节点死亡。引擎会按「角色/名称/属性/祖先上下文」身份签名在全文档找同一个控件：恰好 1 个匹配 → 自动重绑；0 个或 ≥2 个歧义匹配 → 拒绝执行（fail-closed）。被拒绝时重新 `browser_snapshot`，不要重放旧 ref。换页后旧 ref 全部作废。
- **真 Edge 的 ref 语义更严**（模式③）：`r1` 这类 ref 记录的是「tag + 可访问名 + 角色 + 同名序号」。动作前会复核「同签名元素总数是否仍与快照一致」——页面新增/删除了同名控件就拒绝（宁可失败也不点错）。失败时重新快照。
- **元素被拒的三种原因**：快照报「元素不可见 / 已禁用 / 引用已失效」时，对应处理：滚动到可见、等它启用、重新快照。不要对着同一个 ref 反复重试。
- **SPA 等待不用自己猜**：navigate 后引擎会自动等网络空闲 + 页面稳定（约 2 秒上限）再返回快照；确实很慢的页面给 `wait_ms` 加等。真 Edge 只等到 `load` 事件（不额外拖长），慢站给 `wait_ms`。
- **结构优先，像素其次**：判断「页面对不对」用 browser_snapshot；`browser_screenshot` 留给需要看视觉效果或给用户展示的时候。读数值/属性用 `browser_evaluate`（只读优先）。
- **同一回复内的失败熔断**：同一次回复里某个自动化工具失败后，后续同类调用会被自动跳过。先读错误与已执行结果，重新判断下一步。
- **只验证不破坏**：默认只做只读与可逆操作。**在真 Edge 里动作尤其要保守**——那是用户真实账号，提交订单、发帖、删数据、改资料一律先问用户。

## 隐私与数据（用户会问的问题）

- 模式①不写磁盘：关掉浏览器（或 FC 退出）登录态就没了。共享电脑推荐这一档。
- 模式②写 `userData/Partitions/fc-browser-use/`（`Network/Cookies` 等）。设置页「清空浏览器数据」会先关窗、再 `clearStorageData()`（真正让登录态消失的那一步）、最后尽力删目录；Chromium 进程还占着文件时目录可能残留，但**登录态已经清掉**（重启后读不到 cookie）。
- 模式③的 profile 在 `userData/edge-profile/`，与用户日常 Edge 完全隔离；FC 只清自己这一份，不碰用户日常浏览器与其它程序的 profile。
- 端口纪律：FC 占 **9224**；datacrawler 用 9223。两者 profile 与端口都分开，互不干扰。

