# 安装（Claude Code）

## 1. 交活闸（hook，自动拦 git commit/push）

把下面这段加进项目 `.claude/settings.json`（或 `~/.claude/settings.json` 全局生效），
把路径换成你的 FinalCheck 安装位置：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node D:/rcw-geo/yanshou/integrations/claude-code/gate.mjs" }
        ]
      }
    ]
  }
}
```

行为：AI 执行 `git commit` / `git push` / `npm publish` 前，先跑一遍 L2 体检；
结论=拦 或 无法验收 → 命令被阻止（exit 2），AI 会看到原因并先去修。
闸门自身故障时 fail-open 放行并在 stderr 明示（不卡用户）。

## 2. skill（教 AI 自觉体检）

把 `SKILL.md` 复制到 `~/.claude/skills/finalcheck-audit/SKILL.md`（全局）
或项目 `.claude/skills/finalcheck-audit/SKILL.md`（仅本项目）。

## 3. 下载闸 hook（拦 npm install / npx，与交活闸并列的第二个 PreToolUse 条目）

把 `integrations/claude-code/download-gate.mjs` 加进同一个 `PreToolUse` 数组（交活闸 `gate.mjs`
保持不变，两个 hook 都对 `Bash` 生效）。合并后的完整 `settings.json` 片段（路径换成你的
FinalCheck 安装位置）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node D:/rcw-geo/yanshou/integrations/claude-code/gate.mjs" },
          { "type": "command", "command": "node D:/rcw-geo/yanshou/integrations/claude-code/download-gate.mjs" }
        ]
      }
    ]
  }
}
```

行为：AI 执行 `npm i/install/ci/add` 或 `npx` 时，先解析出包名，逐个查 registry
（内存缓存、总请求上限 200、15s 超时，只读元数据不执行任何包代码）：

- **X1 安装脚本**：包本身及依赖 2 层内的 `preinstall/install/postinstall` → 高危，exit 2 拦下并给出脚本证据；
- **X3 投毒信号**：版本发布 <30 天或周下载 <100 → 黄牌高危（typosquat/slopsquat 风险），同样 exit 2；
- 离线/registry 不可达 → 放行并在 stderr 明示覆盖不全；下载闸自身异常 → fail-open exit 0。
- X2 外呼清单 / X4 README 注入是项目级检查，走 CLI `scan-download`（由主会话接线），不在此 hook 里。

注意：本闸只覆盖命令里显式写出包名的场景（`npm ci`、无参数 `npm install` 装 lockfile
全量依赖时不拦，需靠项目级 X1-X4 扫描兜底）。
