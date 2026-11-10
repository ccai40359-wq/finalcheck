---
id: "IC-04"
title: "前端JS与API信息收集 (Frontend JS & API Recon)"
category: 信息收集
category_en: Reconnaissance
difficulty: ★★★
tools: "JSFinder, LinkFinder, URLFinder, SecretFinder"
source: "自建 · 蒸馏自 yaklang/hack-skills attack-surface-mapping / api-recon-and-docs (MIT License)"
---
# 前端JS与API信息收集 (Frontend JS & API Recon)

## 概述
现在的站点大多是 Vue / React 打包出来的单页应用（SPA），页面本身没有多少链接，**接口路径、参数名、加密密钥基本都藏在 JS 文件里**。把 JS 挖透，能拿到 UI 上永远看不到的隐藏接口和硬编码凭据，是单站测试里性价比最高的一步。

## 核心技能

### 1. JS 文件收集

```bash
# 页面源码里直接抓
curl -s http://target.com | grep -oE 'src="[^"]+\.js[^"]*"'

# 关注这几类文件：
# main.xxx.js          应用主逻辑
# chunk-xxx.js / xxx.async.js  异步分块（隐藏页面的代码常在这里）
# vendor.xxx.js        第三方库（看用了什么组件）

# 常见打包特征路径
# /static/js/  /assets/  /_next/static/  /dist/  /js/
```

自动化工具一把梭：

```bash
# JSFinder - 从页面和 JS 里递归提取 URL/接口
python3 JSFinder.py -u http://target.com -d -ou urls.txt -os js.txt

# LinkFinder - 从单个 JS 文件里抠完整接口路径
python3 linkfinder.py -i http://target.com/static/js/main.js -o cli

# URLFinder - 批量抓页面引用的全部 JS 并提取
urlfinder -u http://target.com -s all
```

**没有外链 JS 怎么办（服务端渲染站）**

站点是 Jinja2 / JSP / PHP 这类服务端模板渲染、页面里抓不到任何 `.js` 时，JS 这条路直接为空，接口改从这三处收：

```bash
# 1. 表单：action / method / 全部 input name（含 hidden —— 隐藏字段就是后端收的固定值）
curl -s -b cookie.txt http://target.com/page | grep -ohE '<form[^>]*>|<(input|select|textarea)[^>]*>'

# 2. 路由：全站页面里的链接与跳转目标
curl -s -b cookie.txt http://target.com/page | grep -ohE 'href="/[^"]*"'
# 302 的 Location 头也要收，参数默认值常写在这里（如 /x → /x?id=1）

# 3. 逐页遍历：把导航菜单里每个入口都抓一遍，别只看首页
```

- 先登录取会话，再用同一 Cookie 遍历，否则抓到的是登录页
- 参数语义要实测确认：改一个值看返回是否换数据（如 `id=2` 返回别的用户名），确认参数是与会话绑定的还是可自由指定的
- 页面里回显的 `<script>` 片段可能是留言/评论里的存储型载荷，不是站点自己的 JS，别误判成前端代码
- 文档面一并探一遍：`/swagger.json`、`/openapi.json`、`/api-docs`、`/docs`、`/api/v1/`，全 404 才说明真的没有

### 2. 接口与敏感信息提取清单

拿到 JS 后逐项过一遍，每项都记下"有值"或"无"：

| 提取项 | 为什么要挖 |
|---|---|
| `/api/` 路径、RPC 指令号、GraphQL 操作 | 接口清单，测试的靶子 |
| 签名 salt、硬编码 key、无需 Cookie 的 sign 参数 | 不带登录态也能重放请求 |
| 密文 ID + 前端公钥（`modulus` / JSEncrypt） | 加密的相邻 ID 可以自己加密后越权 |
| 路由表里的隐藏/管理页路由、未发布的 chunk | UI 上不显示的接口入口 |
| 硬编码演示账号、测试租户、体验入口 | 直接一个可用账号，不用爆字典 |
| 命令执行 / 模板渲染 / 文件转换 / agent 工具类接口 | 执行面接口，优先测命令注入、SSTI、SSRF |

### 3. 硬编码密钥检测

```bash
# SecretFinder - 扫 JS 里的 apikey/secret/token
python3 SecretFinder.py -i http://target.com/static/js/main.js -o cli

# JS 里常见的密钥特征（直接全局搜关键字）
# apikey / api_key / secret / token / accessKey
# AKID、LTAI（阿里云AK）、AKIA（AWS AK）
# -----BEGIN RSA PRIVATE KEY-----
# jdbc:mysql://、redis://、mongodb://（连接串直接写死）
```

### 4. sourcemap 泄露

```bash
# 检测 .js.map 是否可访问（打包时没关 devtool 就会泄露源码）
curl -s -o /dev/null -w "%{http_code}" http://target.com/static/js/main.js.map

# 存在即可还原出完整源码目录（TS 源码、接口封装、内部逻辑全在里面）
# 工具：unmap、 sourcemapper、浏览器 DevTools 直接加载
```

### 5. OpenAPI / Swagger 文档与隐藏端点

```text
/swagger-ui.html          /swagger-ui/           # Springfox
/v2/api-docs              /v3/api-docs           # Springdoc/OpenAPI JSON
/openapi.json             /openapi.yaml
/doc.html                 /webjars/springfox-swagger-ui/swagger-ui.html   # knife4j
/eolinker/  /yapi/                               # 接口管理平台
```

拿到 JSON 后用工具渲染成可交互文档，接口清单直接到手：

```bash
# 用 swagger-codegen 或 apifox 导入，逐个核对是否需要鉴权
```

### 6. 注释与调试入口

```bash
# HTML/JS 注释里的线索
curl -s http://target.com | grep -oE '<!--.*-->' | grep -iE "test|debug|admin|todo|password"
# JS 里的 console.log 调试输出、注释掉的接口
# 常见调试入口：/debug/  /test/  /trace  /actuator/heapdump
```

### 7. 接口验证（关键收口）

抠出来的接口**逐个验证**，判定标准：

- 只返回一句"请登录" / `NotLogin`，无任何列表、字段 → 登录门，先放一边
- 返回了列表、total、业务字段（哪怕 `total=0`）→ 结构性响应，**重点测试对象**
- 少传一个参数就返回完整数据 → 未授权访问，最高优先级
- 每个接口记录：路径、方法、参数、是否需要登录、响应特征

## 常用工具
| 工具 | 用途 | 链接 |
|:---|:---|:---|
| JSFinder | 页面+JS 递归提取 URL | https://github.com/Threezh1/JSFinder |
| LinkFinder | 单个 JS 内抠完整接口路径 | https://github.com/GerbenJavado/LinkFinder |
| SecretFinder | JS 内硬编码密钥检测 | https://github.com/m4ll0k/SecretFinder |
| URLFinder | 批量 JS 收集与提取 | https://github.com/pingc0y/URLFinder |

## 参考资源
- 提取清单来源：hack-skills · attack-surface-mapping
- 附属原文：`前端JS与API信息收集-API信息收集原文-APIRecon.md`（同目录）
