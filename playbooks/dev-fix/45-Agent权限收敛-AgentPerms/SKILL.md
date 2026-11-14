---
name: fix-a1-perms
description: Use when audit 报 A1.permissive-allow / A1.bypass-mode / A1.risky-allow（Agent/MCP 工具权限过宽），或用户提到收敛 allow 白名单、关 bypass、解释器前缀改枚举时加载。
description_en: Tighten agent tool permissions: replace wildcard allows with enumerated commands, drop interpreter prefixes, disable bypass/auto-approve modes, then re-run the A1 gate.
---

# Agent 权限收敛 (fix-a1-perms)

A1 的三型通病：通配放行、bypass 开关、解释器前缀。修法都是同一个方向——把「什么都能干」改成「枚举出的少数安全动作 + 其余走审批」。

## 适用场景

- `A1.permissive-allow`：权限配置 allow 列表里有 `"*"`、`Bash(*)`、`mcp:*` 这类全量通配
- `A1.bypass-mode` / `A1.bypass-flag`：defaultMode 设了 bypassPermissions，或命令行带了 `--dangerously-skip-permissions` / auto-approve 全开
- `A1.risky-allow`：allow 里放了 `Bash(python -c*)`、`Bash(bash -c*)`、`Bash(node -e*)` 等可执行任意代码的解释器条目
- 关联：`A1.no-sandbox` / `A1.mcp-shell-wrap`（MCP 工具包装 shell）同思路收敛

## 修复步骤

1. 定位权限配置文件（.zcode/settings.json、.claude/settings.json、MCP server 配置、CI 里的 agent 启动参数），把通配改成显式枚举：
   ```json
   // 改前
   { "permissions": { "allow": ["Bash(*)", "mcp__*"] } }
   // 改后：只枚举本项目日常确实要自动执行的动作
   { "permissions": { "allow": [
     "Bash(npm test*)", "Bash(npm run lint*)", "Bash(npm run build)",
     "Bash(git status)", "Bash(git diff*)", "Bash(git log*)",
     "Read(*)", "Grep(*)", "Glob(*)"
   ] } }
   ```
   写操作（rm、git push）、网络命令（curl、wget）一律不进 allow，留给审批。
2. 删掉解释器前缀条目：`python -c*` / `bash -c*` / `node -e*` 等于放行任意代码，白名单形同虚设。确有固定脚本要跑，改成枚举具体脚本路径：
   ```json
   { "permissions": { "allow": ["Bash(python scripts/check_links.py*)", "Bash(python scripts/backup_db.sh*)"] } }
   ```
   通用临时计算需求删掉，靠审批兜底。
3. 关掉 bypass / 自动审批开关：
   ```json
   // 改前
   { "permissions": { "defaultMode": "bypassPermissions", "skipApprovals": true } }
   // 改后
   { "permissions": { "defaultMode": "default" } }
   ```
   CI 无人值守确需自动执行时，收窄到最小命令集（见步骤 1）加容器 / sandbox 隔离，而不是全局 bypass。启动命令里的 `--dangerously-skip-permissions` 等旗标同步删除。
4. MCP 工具若有 shell 包装（wrap shell 工具），改成只暴露具体语义的子工具（如 `run_tests`、`lint`），工具内部再走白名单 execFile。
5. 自查残留：
   ```bash
   grep -nE '"\*"|Bash\(\*\)|-c\*|-e\*|bypass|skipApprovals' .zcode/settings.json .claude/settings.json 2>/dev/null
   ```
   命中任何一行就回到步骤 1 继续收敛。

## 验证

- 重跑 `finalcheck audit .` 确认 A1 归零：`A1.permissive-allow`、`A1.bypass-mode`、`A1.risky-allow` 条目全部消失
- 功能冒烟：agent 跑一遍常规任务（跑测试、查 git 状态）确认枚举命令仍可自动执行，敏感命令（rm、curl）会弹审批而不是静默执行
- CI 场景：跑一遍流水线确认任务没有因权限收窄而挂；挂了就把缺的命令补成枚举条目，而不是恢复通配

## 陷阱

- 换一个宽前缀继续自欺：`Bash(echo*)` 收掉后改成 `Bash(sh*)` 或 `Bash(./scripts/*)`，脚本目录可写时等于任意执行；枚举要精确到具体命令与脚本
- 只清 allow 不改 defaultMode：allow 收干净了但 defaultMode 仍是 bypassPermissions，`A1.bypass-mode` 照报；两处必须一起改
- 权限收太死导致 agent 瘫痪：一条工具不给会让自动化任务全部卡审批；正确姿势是枚举高频安全命令 + 敏感动作走人审
- 项目级白名单抄进全局用户配置：`Bash(./gradlew*)` 进了全局配置后其他项目也自动放行；构建命令留项目级，全局只放真正通用的只读命令
- 只改配置没重启会话：部分客户端加载权限在会话启动时快照，改完 settings 要重开会话再验证
- 收敛后没留审计痕迹：改权限是一次性动作，建议把改前改后的 allow 列表 diff 贴进提交说明，方便下次审计时回溯为什么放行这些命令
