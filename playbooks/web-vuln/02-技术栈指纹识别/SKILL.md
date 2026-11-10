---
name: tech-fingerprint
description: 识别目标 Web 技术栈时使用。Use when 用户提到 WhatWeb、Wappalyzer、EHole、wafw00f、CMS 识别、中间件版本（Tomcat/WebLogic/ThinkPHP）、框架指纹、WAF 识别，或需要为 payload/字典选择确认技术栈时加载。
---

# 技术栈指纹识别 (tech-fingerprint)

识别目标 Web 技术栈时使用。Use when 用户提到 WhatWeb、Wappalyzer、EHole、wafw00f、CMS 识别、中间件版本（Tomcat/WebLogic/ThinkPHP）、框架指纹、WAF 识别，或需要为 payload/字典选择确认技术栈时加载。

## 何时使用

- 上述 description 中列出的场景命中任意一条时，先读本入口，再按需下钻
- 附属手册按场景加载：场景集（SCENARIOS）、payload 手册、进阶技巧

## 文件路由

| 文件 | 用途 |
|---|---|
| [技术栈指纹识别-TechFingerprint.md](技术栈指纹识别-TechFingerprint.md) | 主手册（正文保留原文） |

## 上手顺序

1. 读主手册开头的 ROUTING / 概述章节，确认命中本技能
2. 按主手册章节执行测试（正文为英文实战手册，章节标题可检索）
3. 命中具体场景（如某厂商 WAF、某引擎）时再读对应附属手册
