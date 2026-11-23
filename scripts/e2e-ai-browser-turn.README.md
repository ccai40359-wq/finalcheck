# AI 操作端到端（第三层「AI 操作」那一段）

用户给的四层测试模型里，第 3 层是「从用户入口出发，检查一整个业务流程」。
本仓库原先只做到「人点浏览器」这一段（`testbench-rail-humanflow.mjs`），
**「AI 操作」这一段是空的**：那个测试台的 provider 指向本地 `/v1`，而它没有这个路由（一律 404）。

`e2e-ai-browser-turn.mjs` 补的就是这一段。

## 用法

```bash
# 默认：真网关（读 %APPDATA%/FinalCheck/config.json 里你自己的 provider）
node scripts/e2e-ai-browser-turn.mjs

# 离线/CI 回归：脚本化假网关，不需要网络和额度
node scripts/e2e-ai-browser-turn.mjs --fake
```

退出码 0 = 全过，1 = 有失败。

## 它验什么（6 条断言）

| # | 断言 | 为什么这条重要 |
|---|---|---|
| A1 | AI 真的调用了 `browser_navigate` | 只看 `out.trace`，不看模型自述 |
| A2 | AI 拿到了页面内容（读页面工具，或 navigate 返回值自带快照） | `browser_navigate` 默认 `observe:true` **自带整页快照**，所以只调 navigate 就已经读到了 —— 判据必须认这一点 |
| A3 | 页面真的开在内置浏览器里（`embedded:true`，标签 URL 含 /one） | 防止「页面其实开在看不见的隐藏窗口里」 |
| A4 | 答案里的校验码与工具返回值里的一致 | 结果一致性 |
| A5 | **工具返回值**里真的含页面校验码 | 唯一可信的证据来源（模型自述不算） |
| A6 | 模型没有「声称调过某工具但实际没调」 | 真网关实测抓到模型会编："snapshot 与 innerText 两处独立读取一致"，但 snapshot 根本没调 |

页面里每次运行都埋一个随机校验码 `FC-xxxxxxxx`，只存在于页面正文。
模型编不出来 —— 必须真的读到内容，答案里才可能有它。这是把
「AI 说它看过了」和「AI 真的看到了」分开的唯一办法。

## 必须在真 Electron 里跑（技术前提）

`browser_navigate` / `browser_snapshot` 这些工具**只在 `getDesktopToolsAsync` 存在时才注册**
（依赖 Electron 的 `desktopCapturer` / `WebContentsView`）。纯 Node 里根本没有这些工具。
所以脚本用 bootstrap 方式（同 `scripts/browser-use-acceptance.mjs`）把自己重新 launch 进 Electron。

## 真网关跑出来的三个真实发现（假网关永远看不到）

1. **`ask_user` 必须实现**：模型第一次开网页前会问「用哪种浏览器模式」，没实现就 `ok=false`。
   本次实测它自己改路径绕过去了，换个模型可能卡死。探针里替它答「一次性无痕」。
2. **`browser_navigate` 默认自带整页快照**（`observe !== false`）。所以「AI 读到了内容」这件事
   不需要额外的 snapshot 调用 —— 我第一版把它判成失败，是**判据写错了**，不是产品有问题。
3. **模型会在自我描述里编**：一次运行中它写「`browser_snapshot` 的结构树与 `innerText` 两处独立读取一致」，
   但它只调了 `browser_evaluate`，snapshot 一次都没调。于是加了 A6 专门抓这种幻觉。

第 2、3 条是真网关跑出来的；假网关（脚本决定 tool_calls）永远暴露不了，
这就是「必须真网关」的理由。
