# FinalCheck 仓库约定

## 发版检查清单（强制）

`CHANGELOG.md`（仓库根）是发版的**唯一事实来源**。每次发版按下面的顺序做，顺序不可颠倒、步骤不可跳过：

1. **定版本号**：改 `desktop/package.json` 的 `version`（本清单之外单独评审，不由自动化改）。
2. **先写更新记录**：在 `CHANGELOG.md` 顶部新增 `## [x.y.z] - YYYY-MM-DD`，正文固定三段：`### 新增` / `### 修复` / `### 优化`（没有内容的段省略）。每条一句话、说人话、写用户能感知到什么。
3. **过闸门**：在仓库根跑 `node scripts/run-tests.mjs`（含 `tests/changelog.test.mjs`：当前 `package.json` 版本号必须出现在 `CHANGELOG.md` 且至少有一条内容）、`cd desktop && npx electron-vite build`。
4. **从 CHANGELOG 生成 Release 正文**：`node scripts/release-notes.mjs x.y.z .tmp/release-notes.md`。不要手写正文，避免和 CHANGELOG 漂移。
5. **创建 Release（此时不放安装包）**：`gh release create vX.Y.Z --title "FinalCheck X.Y.Z · 终检 X.Y.Z" --notes-file .tmp/release-notes.md`。
6. **最后才发安装包**：构建并上传 `fc-setup-<version>.exe` 及 `latest.yml` 等产物到该 Release。

禁止事项：

- 没有 CHANGELOG 对应版本段就执行 `gh release create`（`tests/changelog.test.mjs` 会 fail，视为发版失败）。
- Release 正文与 CHANGELOG 不一致，或正文里写了 CHANGELOG 没有的内容。
- 先发安装包再补更新记录。
- 同一版本出现两个 `## [x.y.z]` 标题（解析器会合并，但版本历史不再可信）。

## 其它约定

- 测试入口：`node scripts/run-tests.mjs`，新增测试放 `tests/*.test.mjs`。
- 桌面端构建：`cd desktop && npx electron-vite build`；不要求发版时不要执行打包命令。
- 渲染层纯函数放 `desktop/src/renderer/lib/*.mjs`，便于主进程与测试共用；界面文案一律 `t('中文原文')`，英文同步到 `desktop/src/renderer/i18n/en/`。
