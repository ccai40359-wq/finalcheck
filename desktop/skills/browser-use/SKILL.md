---
name: browser-use
description: Use when 操作网页：打开页面/点击/填表/读控制台。用户点名 /browser-use 或要求 AI 打开网址做验证/抓取/自动化时加载；桌面软件改用 /computer-use。
description_en: Automate web pages with the browser_* tools: navigate returns a structural snapshot with refs, act only on the latest refs, pass observe:true to verify after clicks, check browser_console when a page misbehaves, and rely on the engine's automatic SPA settling instead of guessing wait times.
---

# 网页操作（browser-use）

用 `browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type` 等工具操作网页。核心循环：**navigate 拿快照 → 用最新 ref 动作 → observe 验证 → 出问题查 console**。优先依赖**结构快照**（角色/名称/ref），像素截图只留给「需要看排版/给用户看」的场合。

## 标准循环（严格按顺序）

1. **打开页面**：`browser_navigate(url)`。默认同时返回页面结构快照和每个可操作元素的 `ref`——先读这个快照，不要凭空猜元素。注意：这是独立浏览器窗口，**不继承用户浏览器里的登录态**，需要登录的页面要么有测试账号、要么请用户配合。
2. **用最新 ref 动作**：点击用 `browser_click(ref)`，输入用 `browser_type(ref, text)`。ref 必须来自**最近一次**快照——页面变过就先 `browser_snapshot` 刷新（可用 `query` 关键词缩小范围找元素）。
3. **验证变化**：预计点击会跳转/翻页/弹层时传 `observe: true`，同一次调用里拿点击后的新快照；或动作后自己再 `browser_snapshot`。输入完成后提交前建议快照确认填对了字段。
4. **页面不对先查 console**：元素找不到、点击没反应、白屏时调 `browser_console` 读最近 50 条控制台错误——JS 报错多半在这里。
5. **收尾**：临时验证完调 `browser_close` 关窗，不要留一堆后台浏览器窗口。

## 边界与已知坑

- **ref 会失效，但有自动重绑**：页面重渲染（React/Vue 常态）会让旧 ref 持有的 DOM 节点死亡。引擎会按「角色/名称/属性/祖先上下文」身份签名在全文档找同一个控件：恰好 1 个匹配 → 自动重绑，动作照常执行；0 个或 ≥2 个歧义匹配 → 拒绝执行（fail-closed，宁可不点也不点错）。被拒绝时重新 `browser_snapshot` 拿新 ref，不要重放旧 ref。换页/跨域导航后旧 ref 全部作废，重绑只发生在同一文档内。
- **元素被拒的三种原因**：快照报「元素不可见 / 已禁用 / 引用已失效」时，对应处理：滚动到可见、等它启用、重新快照。不要对着同一个 ref 反复重试。
- **SPA 等待不用自己猜**：navigate 后引擎会自动等网络空闲 + 页面稳定（约 2 秒上限）再返回快照；确实很慢的页面给 `wait_ms` 加等。不要自己写死 sleep 轮询。
- **结构优先，像素其次**：判断「页面对不对」用 browser_snapshot（结构/角色/文本）；`browser_screenshot` 留给需要看视觉效果或给用户展示的时候。读数值/属性等细节用 `browser_evaluate`（只读用途优先，改页面状态要谨慎）。
- **同一回复内的失败熔断**：同一次回复里某个自动化工具失败后，后续同类调用会被自动跳过。先读错误与已执行结果，重新判断下一步，不要盲目重放。
- **只验证不破坏**：默认只做只读与可逆操作（导航、点击查看、填表不提交）；提交订单、删除数据、支付这类不可逆动作，先向用户确认再动手。
