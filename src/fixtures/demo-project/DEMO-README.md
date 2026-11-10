# 这是故意带洞的演示项目，不要部署

本目录是 FinalCheck 的**体检样本**，不是可运行的产品。

- 不要部署到服务器，不要拿它对外提供服务。
- 不要把这里的代码当模板抄进真实项目。
- 代码不会联网、不会执行系统命令、不会启动网络监听；`app.js` 在 import 时只构建路由表。
- `package.json` 写了 `express`，但**故意不安装依赖、不提交 lockfile**。这会让依赖检查记为“覆盖缺口”，正好演示 FinalCheck 的缺口语义。

## 每处洞对应的检查

| 位置 | 检查项 | 说明 |
|---|---|---|
| `app.js:112` `app.get('/api/users/:id', ...)` | **S1** `S1.no-guard` | 带动态 id 的接口没有登录守卫，任何人都能调用。修法：挂 `requireAuth`，或确认公开后登记到 `publicRoutes`。 |
| `app.js:114` 查询语句 | **S2** `S2.sqli-concat` | 把 `req.params.id` 用加号拼进 SQL。修法：参数化查询（占位符 `?` / `$1`）。同文件 `app.js:48` 是正确的参数化对照写法。 |
| `app.js:30` `API_KEY` 常量 | **S3** `S3.secret-literal` | 硬编码的演示假 Key，看起来像真密钥。修法：移到 `.env`，代码用 `process.env.API_KEY` 读取；若曾提交过 git，视为已泄漏并轮换。 |
| `app.js:104` CORS 中间件 | **S5** `S5.cors-wildcard` | CORS 允许任意来源。修法：改成明确的域名白名单。 |
| `README.md` | **H1** `H1.readme-short` | README 少于 400 字符，且故意不写安装/启动步骤，接手者不知道该怎么跑。 |
| `README.md` 无启动关键词 | **H1** `H1.readme-no-start-keyword` | README 不出现 install/run/start/启动/安装/使用，接手者不知道如何运行。 |
| `app.js:33` `DB_PASSWORD` | **H1** `H1.env-sample-missing-vars` | 代码读取 `DB_PASSWORD`，但 `.env.example` 只列了 `PORT`。修法：把变量名补进样本文件（值留占位符）。 |
| 无 `package-lock.json` | **S4** 覆盖缺口 | 没有 lockfile，依赖 CVE 检查无法运行。报告会显示“无法验收”并注明 S4 未跑；这是“有关没跑”，不是“发现漏洞”。 |

## 预期结果（L2）

- 三条高危：S1（未鉴权接口）、S2（SQL 拼接）、S3（硬编码 Key）。
- 中危：S5 一条（CORS 任意来源）；H1 三条（README 过短、README 无启动关键词、`.env.example` 缺 `DB_PASSWORD`）。
- 一条覆盖缺口：S4（没有 lockfile）。
- 在桌面端默认不执行项目测试时，Q1 也会记为覆盖缺口（未授权执行测试），所以结论会是“无法验收”，而不是“拦”。

## 怎么体检

在 FinalCheck 桌面版左侧 Workspaces 里添加本目录，新建会话，点“代码体检”卡片，或直接说：

> 对当前项目做一次 L2 安全体检，结论带文件:行证据。

也可以在 FinalCheck 仓库根用 CLI（不要在被审目录里跑 `npx`，避免联网装包）：

```bash
node bin/finalcheck.js audit src/fixtures/demo-project --tier L2 --no-tests
```

`--no-tests` 表示不执行本项目的测试命令，只做静态检查。去掉它则会运行 `npm test`；本项目的测试是绿色安全的。
