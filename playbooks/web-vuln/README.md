# Web 漏洞技能集

整理自 [yaklang/hack-skills](https://github.com/yaklang/hack-skills)（MIT License）与 [Hi-FullHouse/CyberSecurity-Skills](https://github.com/Hi-FullHouse/CyberSecurity-Skills)（MIT License），共 **40 个技能**。归档顺序：**01–04 信息收集**（针对单站：端口 → 指纹 → 目录 → JS/API），**05–35 经典漏洞类型**，**36–38 绕过类**，**39 框架与组件已知漏洞（N-day）**，**40 漏洞报告生成**（把已确认的漏洞整理成补天／漏洞盒子可提交的报告）。每个技能一个编号文件夹，附属手册（场景集 / payload 手册 / 高级技巧）放在对应文件夹内。

三类环节的区别：**05–35 按「输入点」测**（看到一个参数，判断它进到哪儿，配对应手法），**39 按「组件版本」测**（先认框架与版本，再对该版本的已知 CVE 逐项检索验证），**40 不测漏洞、只做交付**（输入是已人工复现的事实，输出是平台能收的报告，缺截图留标注交人工补）。39/40 放在末尾编号，是为了不打乱 05–35 已被提示词引用的既有编号。

## 目录结构

### 信息收集（01–04，针对单个网站）

| 编号 | 文件夹 | 技能 |
|---|---|---|
| 01 | `01-端口扫描与服务识别/` | Nmap、Masscan、RustScan 端口扫描与服务指纹 |
| 02 | `02-技术栈指纹识别/` | Web 指纹（WhatWeb/Wappalyzer）、中间件版本、WAF 识别（wafw00f） |
| 03 | `03-目录与敏感文件爆破/` | dirsearch/gobuster：后台路径、备份文件、.git/.svn、编辑器入口（附源码管理泄露原文） |
| 04 | `04-前端JS与API信息收集/` | JS 文件分析（接口路径、硬编码密钥、sourcemap）、Swagger 文档、隐藏端点、注释泄露（附 API 信息收集原文） |

### 经典漏洞类型（05–35）

| 编号 | 文件夹 | 技能 |
|---|---|---|
| 05 | `05-SQL注入-SQLInjection/` | SQL 注入（附场景集、SQLMap 高级用法） |
| 06 | `06-XSS跨站脚本-XSS/` | XSS 跨站脚本（附进阶技巧、场景集） |
| 07 | `07-命令注入-CommandInjection/` | 命令注入 |
| 08 | `08-文件上传-InsecureFileUpload/` | 不安全文件上传（附场景集） |
| 09 | `09-路径穿越与文件包含-PathTraversalLFI/` | 路径穿越与文件包含 |
| 10 | `10-XXE注入-XXE/` | XML 外部实体注入（附场景集） |
| 11 | `11-SSRF-SSRF/` | SSRF 服务端请求伪造（附场景集、URL 解析技巧） |
| 12 | `12-反序列化-InsecureDeserialization/` | 反序列化（附 Java Gadget 链） |
| 13 | `13-模板注入-SSTI/` | 模板注入（附引擎 payload 集、场景集） |
| 14 | `14-NoSQL注入-NoSQLInjection/` | NoSQL 注入 |
| 15 | `15-表达式注入-ELInjection/` | 表达式注入 |
| 16 | `16-JNDI注入-JNDIInjection/` | JNDI 注入 |
| 17 | `17-CRLF注入-CRLFInjection/` | CRLF 注入 |
| 18 | `18-XSLT注入-XSLTInjection/` | XSLT 注入 |
| 19 | `19-CSV公式注入-CSVFormulaInjection/` | CSV 公式注入 |
| 20 | `20-邮件头注入-EmailHeaderInjection/` | 邮件头注入 |
| 21 | `21-越权访问-IDOR/` | 越权访问 |
| 22 | `22-认证绕过-AuthBypass/` | 认证绕过 |
| 23 | `23-JWT与令牌攻击-JWTTokenAttacks/` | JWT 与令牌攻击 |
| 24 | `24-OAuth配置错误-OAuthOIDC/` | OAuth 配置错误 |
| 25 | `25-业务逻辑漏洞-BusinessLogic/` | 业务逻辑漏洞（附方法论、检查清单、场景集） |
| 26 | `26-竞态条件-RaceCondition/` | 竞态条件 |
| 27 | `27-CORS配置错误-CORSMisconfig/` | CORS 配置错误（附场景集） |
| 28 | `28-跨站请求伪造-CSRF/` | 跨站请求伪造 |
| 29 | `29-点击劫持-Clickjacking/` | 点击劫持 |
| 30 | `30-开放重定向-OpenRedirect/` | 开放重定向 |
| 31 | `31-子域名接管-SubdomainTakeover/` | 子域名接管 |
| 32 | `32-DNS重绑定-DNSRebinding/` | DNS 重绑定 |
| 33 | `33-API信息收集-APIRecon/` | API 信息收集 |
| 34 | `34-API授权与BOLA-APIBOLA/` | API 授权与 BOLA |
| 35 | `35-API认证滥用-APIAuthAbuse/` | API 认证滥用 |

### 绕过类（36–38）

| 编号 | 文件夹 | 技能 |
|---|---|---|
| 36 | `36-401-403绕过-AccessBypass/` | 401/403 访问绕过 |
| 37 | `37-WAF绕过-WAFBypass/` | WAF 绕过（附产品矩阵） |
| 38 | `38-CSP绕过-CSPBypass/` | CSP 绕过 |

### 框架与组件已知漏洞（39）

| 编号 | 文件夹 | 技能 |
|---|---|---|
| 39 | `39-框架与组件已知漏洞-NdayVuln/` | N-day 四步链路：版本识别 → 联网检索 CVE/PoC → 逐项验证 → 判定归档（含框架 payload 形态对照表、ThinkPHP 5.0.x 实测样本、curl 转义规则） |

### 报告与提交（40）

| 编号 | 文件夹 | 技能 |
|---|---|---|
| 40 | `40-漏洞报告生成-VulnReportGen/` | 漏洞报告九段结构（标题/影响资产/类型/等级/描述/复现步骤/请求与响应/危害说明/修复建议）、逐段写法与退单点、**各类漏洞的验证上限表**（验到哪一步就停，含两家平台的越界红线）、证据留法（截图缺口标注约定）、危害等级判定（含敏感字段判定尺子）、补天与漏洞盒子字段差异、**会直接判定重复或忽略的规则**（同源合并 / 禁止拆分 / 弱口令 / 越界）、AI 辅助报告红线（两家公告）、提交后进度与返工、提交前自检清单 |

> 说明：每个文件夹内含标准 `SKILL.md` 入口（frontmatter 带 name + description 触发描述，正文为中文文件路由表），可直接被 AI Agent 工具装载；信息收集 01/02 来自 CyberSecurity-Skills（中文原文），03/04、39、40 为自建中文技能（03/04 蒸馏自 hack-skills，附属原文保留英文）；漏洞技能正文保留英文原文，文件命名与 frontmatter 为中文；已按需移除原型污染、类型松散比较、SAML、GraphQL、GhostBits、请求走私、Host 头攻击、HTTP/2 攻击、Web 缓存欺骗、HTTP 参数污染、悬挂标记注入等技能。
