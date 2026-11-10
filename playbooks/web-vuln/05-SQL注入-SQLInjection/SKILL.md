---
name: sql-injection
description: 测试 SQL 注入时使用。Use when 目标存在数据库交互（登录框、搜索、列表、分页、排序），或用户提到 SQLi、sqlmap、union 注入、盲注、报错注入、WAF 绕过矩阵、多数据库利用时加载。
---

# SQL注入 (sql-injection)

测试 SQL 注入时使用。Use when 目标存在数据库交互（登录框、搜索、列表、分页、排序），或用户提到 SQLi、sqlmap、union 注入、盲注、报错注入、WAF 绕过矩阵、多数据库利用时加载。

## 何时使用

- 上述 description 中列出的场景命中任意一条时，先读本入口，再按需下钻
- 附属手册按场景加载：场景集（SCENARIOS）、payload 手册、进阶技巧

## 文件路由

| 文件 | 用途 |
|---|---|
| [SQL注入-SQLInjection.md](SQL注入-SQLInjection.md) | 主手册（正文保留原文） |
| [SQL注入-SQLInjection-SCENARIOS.md](SQL注入-SQLInjection-SCENARIOS.md) | 附属手册 |
| [SQL注入-SQLInjection-SQLMAP_ADVANCED.md](SQL注入-SQLInjection-SQLMAP_ADVANCED.md) | 附属手册 |

## 上手顺序

1. 读主手册开头的 ROUTING / 概述章节，确认命中本技能
2. 按主手册章节执行测试（正文为英文实战手册，章节标题可检索）
3. 命中具体场景（如某厂商 WAF、某引擎）时再读对应附属手册
