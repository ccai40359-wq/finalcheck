---
name: nday-vuln
description: 排查框架与组件已知漏洞（N-day）时使用。Use when 目标是 ThinkPHP/Spring/Struts2/Fastjson/WebLogic/Shiro/WordPress/Django/Flask 等框架，或用户提到 N-day、已知漏洞、CVE 复现、组件版本漏洞、中间件漏洞、找 PoC、指纹版本比对时加载。
---

# 框架与组件已知漏洞 (nday-vuln)

排查框架与组件已知漏洞（N-day）时使用。Use when 目标是 ThinkPHP/Spring/Struts2/Fastjson/WebLogic/Shiro/WordPress/Django/Flask 等框架，或用户提到 N-day、已知漏洞、CVE 复现、组件版本漏洞、中间件漏洞、找 PoC、指纹版本比对时加载。

## 何时使用

- 上述 description 中列出的场景命中任意一条时，先读本入口，再按需下钻
- 已知目标框架与版本、要求复现某个 CVE 时
- 授权靶场或 SRC 授权范围内做提交前自检时
- 本条的入口是**版本号**，不是参数：先认版本，再对版本查已知漏洞

## 文件路由

| 文件 | 用途 |
|:---|:---|
| [框架与组件已知漏洞-NdayVuln.md](框架与组件已知漏洞-NdayVuln.md) | 主手册（版本识别 → 联网检索 CVE/PoC → 逐项验证 → 判定归档） |

## 上手顺序

1. 读主手册开头的概述与「按输入点测」的差别表，确认本条适用
2. 按四步走：版本识别（产出框架名 / 版本号 / 组件清单 / 报错特征）→ 联网检索 → 逐项验证 → 判定归档
3. 验证阶段按 3.1 的复现单元格式逐条输出，含对照表与实测样本可直接套用

