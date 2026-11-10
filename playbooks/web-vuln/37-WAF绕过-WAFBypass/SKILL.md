---
name: waf-bypass
description: 被 WAF 拦截需要绕过时使用。Use when payload 被安全设备拦截，或用户提到 WAF 指纹识别、编码绕过、分块传输、厂商级绕过（Cloudflare/AWS WAF/ModSecurity）、绕过决策树时加载。
---

# WAF绕过 (waf-bypass)

被 WAF 拦截需要绕过时使用。Use when payload 被安全设备拦截，或用户提到 WAF 指纹识别、编码绕过、分块传输、厂商级绕过（Cloudflare/AWS WAF/ModSecurity）、绕过决策树时加载。

## 何时使用

- 上述 description 中列出的场景命中任意一条时，先读本入口，再按需下钻
- 附属手册按场景加载：场景集（SCENARIOS）、payload 手册、进阶技巧

## 文件路由

| 文件 | 用途 |
|---|---|
| [WAF绕过-WAFBypass.md](WAF绕过-WAFBypass.md) | 主手册（正文保留原文） |
| [WAF绕过-WAFBypass-WAF_PRODUCT_MATRIX.md](WAF绕过-WAFBypass-WAF_PRODUCT_MATRIX.md) | 附属手册 |

## 上手顺序

1. 读主手册开头的 ROUTING / 概述章节，确认命中本技能
2. 按主手册章节执行测试（正文为英文实战手册，章节标题可检索）
3. 命中具体场景（如某厂商 WAF、某引擎）时再读对应附属手册
