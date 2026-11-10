---
name: ssrf
description: 测试 SSRF 时使用。Use when 目标存在 URL 拉取功能（预览、导入、webhook、头像抓取），或用户提到 SSRF、内网探测、云元数据、gopher 协议、URL 解析差异时加载。
---

# SSRF (ssrf)

测试 SSRF 时使用。Use when 目标存在 URL 拉取功能（预览、导入、webhook、头像抓取），或用户提到 SSRF、内网探测、云元数据、gopher 协议、URL 解析差异时加载。

## 何时使用

- 上述 description 中列出的场景命中任意一条时，先读本入口，再按需下钻
- 附属手册按场景加载：场景集（SCENARIOS）、payload 手册、进阶技巧

## 文件路由

| 文件 | 用途 |
|---|---|
| [SSRF服务端请求伪造-SSRF.md](SSRF服务端请求伪造-SSRF.md) | 主手册（正文保留原文） |
| [SSRF服务端请求伪造-SSRF-SCENARIOS.md](SSRF服务端请求伪造-SSRF-SCENARIOS.md) | 附属手册 |
| [SSRF服务端请求伪造-SSRF-URL_PARSER_TRICKS.md](SSRF服务端请求伪造-SSRF-URL_PARSER_TRICKS.md) | 附属手册 |

## 上手顺序

1. 读主手册开头的 ROUTING / 概述章节，确认命中本技能
2. 按主手册章节执行测试（正文为英文实战手册，章节标题可检索）
3. 命中具体场景（如某厂商 WAF、某引擎）时再读对应附属手册
