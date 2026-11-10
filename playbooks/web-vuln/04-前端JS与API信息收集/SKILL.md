---
name: js-api-recon
description: 从前端代码挖接口时使用。Use when 用户提到 JS 分析、JSFinder、LinkFinder、sourcemap、硬编码密钥、Swagger/OpenAPI 文档、隐藏端点、注释泄露，或目标是 Vue/React SPA 站点时加载。
---

# 前端JS与API信息收集 (js-api-recon)

从前端代码挖接口时使用。Use when 用户提到 JS 分析、JSFinder、LinkFinder、sourcemap、硬编码密钥、Swagger/OpenAPI 文档、隐藏端点、注释泄露，或目标是 Vue/React SPA 站点时加载。

## 何时使用

- 上述 description 中列出的场景命中任意一条时，先读本入口，再按需下钻
- 附属手册按场景加载：场景集（SCENARIOS）、payload 手册、进阶技巧

## 文件路由

| 文件 | 用途 |
|---|---|
| [前端JS与API信息收集-JSAPIRecon.md](前端JS与API信息收集-JSAPIRecon.md) | 主手册（正文保留原文） |
| [前端JS与API信息收集-API信息收集原文-APIRecon.md](前端JS与API信息收集-API信息收集原文-APIRecon.md) | 附属手册 |

## 上手顺序

1. 读主手册开头的 ROUTING / 概述章节，确认命中本技能
2. 按主手册章节执行测试（正文为英文实战手册，章节标题可检索）
3. 命中具体场景（如某厂商 WAF、某引擎）时再读对应附属手册
