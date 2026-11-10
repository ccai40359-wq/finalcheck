---
name: xss
description: 测试 XSS 时使用。Use when 用户提到 XSS、反射/存储/DOM 型、payload 构造、CSP 绕过、DOM Clobbering、厂商 WAF 绕过（Cloudflare/Akamai）、CSS 注入数据外带时加载。
---

# XSS跨站脚本 (xss)

测试 XSS 时使用。Use when 用户提到 XSS、反射/存储/DOM 型、payload 构造、CSP 绕过、DOM Clobbering、厂商 WAF 绕过（Cloudflare/Akamai）、CSS 注入数据外带时加载。

## 何时使用

- 上述 description 中列出的场景命中任意一条时，先读本入口，再按需下钻
- 附属手册按场景加载：场景集（SCENARIOS）、payload 手册、进阶技巧

## 文件路由

| 文件 | 用途 |
|---|---|
| [XSS跨站脚本-XSS.md](XSS跨站脚本-XSS.md) | 主手册（正文保留原文） |
| [XSS跨站脚本-XSS-ADVANCED_XSS_TRICKS.md](XSS跨站脚本-XSS-ADVANCED_XSS_TRICKS.md) | 附属手册 |
| [XSS跨站脚本-XSS-SCENARIOS.md](XSS跨站脚本-XSS-SCENARIOS.md) | 附属手册 |

## 上手顺序

1. 读主手册开头的 ROUTING / 概述章节，确认命中本技能
2. 按主手册章节执行测试（正文为英文实战手册，章节标题可检索）
3. 命中具体场景（如某厂商 WAF、某引擎）时再读对应附属手册
