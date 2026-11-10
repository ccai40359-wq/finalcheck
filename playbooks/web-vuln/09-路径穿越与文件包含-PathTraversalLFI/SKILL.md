---
name: path-traversal-lfi
description: 测试路径穿越与文件包含时使用。Use when 用户提到 LFI、目录穿越、../../、PHP Wrapper（filter/phar）、任意文件读取、LFI→RCE、日志包含时加载。
---

# 路径穿越与文件包含 (path-traversal-lfi)

测试路径穿越与文件包含时使用。Use when 用户提到 LFI、目录穿越、../../、PHP Wrapper（filter/phar）、任意文件读取、LFI→RCE、日志包含时加载。

## 何时使用

- 上述 description 中列出的场景命中任意一条时，先读本入口，再按需下钻
- 附属手册按场景加载：场景集（SCENARIOS）、payload 手册、进阶技巧

## 文件路由

| 文件 | 用途 |
|---|---|
| [路径穿越与文件包含-PathTraversalLFI.md](路径穿越与文件包含-PathTraversalLFI.md) | 主手册（正文保留原文） |

## 上手顺序

1. 读主手册开头的 ROUTING / 概述章节，确认命中本技能
2. 按主手册章节执行测试（正文为英文实战手册，章节标题可检索）
3. 命中具体场景（如某厂商 WAF、某引擎）时再读对应附属手册
