---
name: command-injection
description: 测试命令注入时使用。Use when 目标存在系统命令拼接特征（ping、文件名处理、后台执行功能），或用户提到 CMDi、命令执行 RCE、通配符绕过、PHP disable_functions 绕过时加载。
---

# 命令注入 (command-injection)

测试命令注入时使用。Use when 目标存在系统命令拼接特征（ping、文件名处理、后台执行功能），或用户提到 CMDi、命令执行 RCE、通配符绕过、PHP disable_functions 绕过时加载。

## 何时使用

- 上述 description 中列出的场景命中任意一条时，先读本入口，再按需下钻
- 附属手册按场景加载：场景集（SCENARIOS）、payload 手册、进阶技巧

## 文件路由

| 文件 | 用途 |
|---|---|
| [命令注入-CommandInjection.md](命令注入-CommandInjection.md) | 主手册（正文保留原文） |

## 上手顺序

1. 读主手册开头的 ROUTING / 概述章节，确认命中本技能
2. 按主手册章节执行测试（正文为英文实战手册，章节标题可检索）
3. 命中具体场景（如某厂商 WAF、某引擎）时再读对应附属手册
