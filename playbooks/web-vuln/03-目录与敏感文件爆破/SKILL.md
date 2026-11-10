---
name: dir-brute
description: 对目标做目录与敏感文件探测时使用。Use when 用户提到 dirsearch、gobuster、ffuf、目录扫描、后台路径、备份文件、.git/.svn 泄露、Adminer/phpMyAdmin 等运维入口时加载。
---

# 目录与敏感文件爆破 (dir-brute)

对目标做目录与敏感文件探测时使用。Use when 用户提到 dirsearch、gobuster、ffuf、目录扫描、后台路径、备份文件、.git/.svn 泄露、Adminer/phpMyAdmin 等运维入口时加载。

## 何时使用

- 上述 description 中列出的场景命中任意一条时，先读本入口，再按需下钻
- 附属手册按场景加载：场景集（SCENARIOS）、payload 手册、进阶技巧

## 文件路由

| 文件 | 用途 |
|---|---|
| [目录与敏感文件爆破-DirBrute.md](目录与敏感文件爆破-DirBrute.md) | 主手册（正文保留原文） |
| [目录与敏感文件爆破-源码管理泄露-源码管理泄露InsecureSourceCodeManagement.md](目录与敏感文件爆破-源码管理泄露-源码管理泄露InsecureSourceCodeManagement.md) | 附属手册 |

## 上手顺序

1. 读主手册开头的 ROUTING / 概述章节，确认命中本技能
2. 按主手册章节执行测试（正文为英文实战手册，章节标题可检索）
3. 命中具体场景（如某厂商 WAF、某引擎）时再读对应附属手册
