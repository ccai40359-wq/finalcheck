---
id: "IC-03"
title: "目录与敏感文件爆破 (Directory & Sensitive File Bruteforce)"
category: 信息收集
category_en: Reconnaissance
difficulty: ★★
tools: "dirsearch, gobuster, ffuf, git-dumper"
source: "自建 · 蒸馏自 yaklang/hack-skills insecure-source-code-management (MIT License)"
---
# 目录与敏感文件爆破 (Directory & Sensitive File Bruteforce)

## 概述
在端口和指纹摸清之后，对站点目录层面做一轮爆破，找出后台入口、备份文件、源码管理泄露和运维面板。这些入口往往比首页更容易拿下，是后续上传、越权、源码审计的重要跳板。**注意：目录爆破会留下大量请求日志，仅在授权范围内进行。**

## 核心技能

### 1. dirsearch 目录爆破

```bash
# 基础扫描
dirsearch -u http://target.com

# 指定扩展名（按指纹结果选）
dirsearch -u http://target.com -e php,asp,aspx,jsp,html,js

# 递归扫描 + 常用过滤
dirsearch -u http://target.com -r -R 3 --exclude-status=404,403

# 指定字典
dirsearch -u http://target.com -w /path/to/wordlist.txt

# Cookie（有账号时可以带登录态扫）
dirsearch -u http://target.com --cookie="PHPSESSID=xxx"
```

### 2. gobuster / ffuf

```bash
# gobuster 目录模式
gobuster dir -u http://target.com -w /usr/share/wordlists/dirb/common.txt -x php,bak,zip,sql -t 50

# gobuster vhost 子域名（单站多虚拟主机时）
gobuster vhost -u http://target.com -w subdomains.txt

# ffuf 按长度过滤误报
ffuf -u http://target.com/FUZZ -w common.txt -fs 0
```

### 3. 字典选择

| 场景 | 字典 | 说明 |
|---|---|---|
| 通用 | `dirb/common.txt`、`dirsearch/db/dicc.txt` | 覆盖常见路径 |
| 后台 | `dirsearch/db/dicc.txt` + admin/login/manage 组合 | 后台入口优先 |
| 技术栈定制 | PHP 站用 php 字典、Java 站加 `/WEB-INF/`、`.do`、`.action` | 按指纹结果选，减少噪音 |
| 备份文件 | 在路径后追加扩展名 `-x bak,zip,tar.gz,sql,old,swp,~` | 见第 4 节 |

### 4. 备份文件探测

```bash
# 常见备份命名
# /index.php.bak  /web.zip  /wwwroot.zip  /site.tar.gz  /db.sql  /backup.sql
# /.index.php.swp  /index.php~  /1.txt  /config.php.old

# 批量验证：字典 + 扩展名组合
dirsearch -u http://target.com -w backup_names.txt -e bak,zip,tar.gz,sql,old,swp
```

### 5. 源码管理泄露（.git / .svn / .hg）

```bash
# 检测是否泄露
curl -s http://target.com/.git/HEAD
# 返回 "ref: refs/heads/main" → 泄露
curl -s http://target.com/.svn/entries
curl -s http://target.com/.hg/store/00manifest.i

# 注意：目录可能 403 但文件可读，403 ≠ 404，要逐文件验证
curl -s http://target.com/.git/config
curl -s http://target.com/.git/objects/ # 换成具体 hash 路径验证

# 一键还原源码
git-dumper http://target.com/.git/ ./output-repo
svn-extractor --url http://target.com/.svn/
```

### 6. 编辑器与运维入口

```text
/adminer.php          # Adminer 数据库管理
/phpmyadmin/          # phpMyAdmin
/mysql/  /sql/        # 自建管理面板常见路径
/WEB-INF/web.xml      # Java 站配置（Tomcat 配置错误时可直接读）
/.env                 # Laravel/Docker 环境变量（含数据库密码、APP_KEY）
/console/  /actuator  # Spring Boot Actuator
/server-status        # Apache 状态页
```

### 7. 结果判定标准

- **200 且长度稳定** → 真实存在，记录并访问确认
- **403** → 路径存在但禁止访问，值得记下（后续可用 403 绕过技巧再试）
- **404 / 统一错误页** → 排除；注意长度过滤，把"统一 404 页面长度"先测出来再跑字典
- **302 跳登录** → 可能是真实后台，跟进去看跳转目标
- 每个确认的入口都要手动访问一次，记录：路径、功能、是否需要登录

## 常用工具
| 工具 | 用途 | 链接 |
|:---|:---|:---|
| dirsearch | 目录爆破首选，自带大字典 | https://github.com/maurosoria/dirsearch |
| gobuster | Go 编写，速度快，支持 vhost/DNS 模式 | https://github.com/OJ/gobuster |
| ffuf | 模糊测试式爆破，过滤能力强 | https://github.com/ffuf/ffuf |
| git-dumper | 一键还原泄露的 .git | https://github.com/arthaud/git-dumper |
| feroxbuster | 递归爆破 | https://github.com/epi052/feroxbuster |

## 参考资源
- [SecLists 字典合集](https://github.com/danielmiessler/SecLists)
- 附属原文：`目录与敏感文件爆破-源码管理泄露-源码管理泄露InsecureSourceCodeManagement.md`（同目录）
