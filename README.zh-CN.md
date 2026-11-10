# FinalCheck · 终检

> **人看不懂的代码，跑之前先过闸。**

给用 AI 写代码、但不懂安全的普通人做的**分级生产就绪验收工具**：

- **先体检，再运行。** AI 写的代码、外来下载的代码，跑之前先检查，出一份**人话报告**。
- **讲证据，不讲感觉。** 不是"可能有 IDOR（CWE-639）"，而是"**第 12 行注册了接口、没挂任何登录守卫——你的用户表对全网裸奔**"，带文件与行号；动态复现是可选第二步。
- **按项目分级。** 个人小项目过 L1 底线；公司项目按 L3 全量验收，未达标不放行。

## 分级

| 档 | 一句话 | 力度 |
|---|---|---|
| **L1 自用** | 数据丢了不心疼，只有自己用 | 只报高危，提醒不拦 |
| **L2 有用户** | 挂公网、有别人的数据进来 | 高危拦截，中危必修 |
| **L3 公司级** | 公司项目 / 收钱 / 有合规义务 | 未达标不放行，出可出示的达标报告 |

## 三件套

| 件 | 形态 | 干什么 |
|---|---|---|
| **桌面端** | Electron（Windows） | 聊天 + 体检台：分级验收、子代理工作流、实时工具轨迹、产物预览、用量统计 |
| **引擎** | 独立 CLI（`npx finalcheck audit <目录>`） | 静态关卡（密钥 / 依赖 / 坏模式 / 鉴权矩阵 / 语义检查）→ 评分卡 + 缺口工单 |
| **Agent 运行时** | 内建于桌面端 | DAG 工作流 **与** 受限脚本 DSL、每条结论强制对抗复核、journal 断点续跑、盲区检查 |
| **闸门与手册** | skill/hook 接线 + `playbooks/` | 下载闸（装/跑外部项目之前）+ 交活闸（把活交出去之前）；规则手册按档写清 AI 该守什么 |

## 快速开始

**安装版**

1. 从 [Releases](https://github.com/ccai40359-wq/finalcheck/releases) 下载 `FinalCheck-install.exe`。
2. 打开后进 **设置 → 模型设置**，填一个 OpenAI 兼容网关（以 `/v1` 结尾的 Base URL、API Key、模型名）。
3. 选一个工作区（文件夹），选定档位，开一个会话。

**从源码跑**

```bash
git clone https://github.com/ccai40359-wq/finalcheck
cd finalcheck
npm install
npm test                     # 647 项测试
cd desktop && npm install
npm run dev                  # 启动桌面端
```

打包 Windows 安装包：`cd desktop && npm run dist`。

## 语言

界面中英双语，**默认中文**（中文系统 + "跟随系统" 时保持中文）。

- **设置 → 运行时 → Language**：跟随系统 / 中文 / English，切换立即生效。
- 选 **English** 时，agent、工作流与生成的报告也输出英文；选 **中文** 时全部保持中文。
- 中文模式下的界面文案与原版逐字一致（`t()` 直接返回中文原文）。

## 安全模型

- API Key **只**存在本地 `config.json`（安装版在 `%APPDATA%\FinalCheck`），不写进会话、日志或报告。
- 路径与命令由策略约束：`workspace`（仅项目目录内可写）、`readonly`（全只读）、`off`（放开项目边界）。敏感位置（`.ssh` / `.aws` / `.gnupg` / Git 凭据 / 私钥）在所有模式下都拒绝，另有命令黑名单。
- 动态目标（探测 / 压测）必须逐目标显式确认，且上限 60s / 50 连接。
- 从项目列表移除工作区不会删除磁盘上的任何文件。

## 仓库结构

```
bin/          CLI 入口（finalcheck、finalcheck-mcp）
src/          体检引擎（各检查项、探测/压测、MCP 接口）
desktop/      Electron 桌面端（main / preload / renderer）
playbooks/    体检 playbook
integrations/ 编码 agent 的 skill + hook 接线
docs/         ACCEPTANCE.md（分级验收的唯一事实源）
tests/        node:test 测试（当前 647 项全绿）
```

## 状态

已能真用但仍在早期：引擎、桌面端、分级闸门、Agent 工作流（DAG + 脚本 DSL）、对抗复核与内置更新都已落地，每次改动跑 647 项测试。本项目自身按 L3 标准开发——本仓库违反 L2 矩阵任何一条，都算 bug。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
