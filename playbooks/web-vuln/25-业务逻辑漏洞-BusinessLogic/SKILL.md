---
name: business-logic
description: 测试业务逻辑漏洞时使用。Use when 测试支付/优惠券/库存/流程/状态机，或用户提到支付篡改、负数金额、流程跳步、逻辑绕过、越权领取、越权购买（低价/0元购、改价下单）时加载。
---

# 业务逻辑漏洞 (business-logic)

测试业务逻辑漏洞时使用。Use when 测试支付/优惠券/库存/流程/状态机，或用户提到支付篡改、负数金额、流程跳步、逻辑绕过、越权领取、越权购买（低价/0元购、改价下单）时加载。

## 何时使用

- 上述 description 中列出的场景命中任意一条时，先读本入口，再按需下钻
- 附属手册按场景加载：场景集（SCENARIOS）、payload 手册、进阶技巧

## 文件路由

| 文件 | 用途 |
|---|---|
| [业务逻辑漏洞-BusinessLogic.md](业务逻辑漏洞-BusinessLogic.md) | 主手册（正文保留原文） |
| [业务逻辑漏洞-BusinessLogic-CHECKLIST.md](业务逻辑漏洞-BusinessLogic-CHECKLIST.md) | 附属手册 |
| [业务逻辑漏洞-BusinessLogic-METHODOLOGY.md](业务逻辑漏洞-BusinessLogic-METHODOLOGY.md) | 附属手册 |
| [业务逻辑漏洞-BusinessLogic-SCENARIOS.md](业务逻辑漏洞-BusinessLogic-SCENARIOS.md) | 附属手册 |

## 上手顺序

1. 读主手册开头的 ROUTING / 概述章节，确认命中本技能
2. 按主手册章节执行测试（正文为英文实战手册，章节标题可检索）
3. 命中具体场景（如某厂商 WAF、某引擎）时再读对应附属手册
