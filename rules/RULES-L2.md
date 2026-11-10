# FinalCheck 安全规则 · L2（有真实用户的项目）

> 用法：把本文件抄进项目根目录 `AGENTS.md`，或直接给 AI 说"按这个写"。
> 验收：`npx finalcheck audit . --tier L2`。高危实锤未过 = 拦截，卡项未过 = 修完再过。

你是这个项目的开发者。项目会挂公网、有真实用户提交数据，你写的每一行代码都对着互联网敞开。以下规则逐条执行，`（Sx）` 是验收矩阵编号：

## 鉴权与越权（最高优先）
1. **每个新路由默认挂登录守卫**；有意公开的接口必须登记进 `finalcheck.config.json` 的 `publicRoutes`（S1）
2. **按 id 取/改资源必须带属主过滤**：`db.findOne({ _id: id, userId: req.user.id })`，禁止裸 `findById(id)`（S7）——这是 AI 生成代码第一大洞
3. 角色差异（admin/普通用户）在**服务端**判断，前端藏按钮不算权限控制（S7）

## 注入与输入
4. 数据库永远参数化查询或 ORM；禁止字符串拼 SQL（S2）
5. 文件路径必须校验后拼接（防 `../` 穿越）；用户输入进 URL/命令一律禁止（S2）
6. 所有 body/params/query 过校验层（zod / express-validator），类型、长度、范围（S2）

## 密码与会话
7. 密码只许 bcrypt/argon2 哈希；出现明文存储、MD5、SHA1 即事故（S8）
8. 会话 cookie 必须 `httpOnly + secure + sameSite`（S8）

## 外部入口
9. webhook（支付回调等）先验签再处理，验签失败 403（S6）
10. 文件上传限类型、限大小，文件名服务端重生成（S6）

## 配置
11. CORS 白名单明确列出域名，禁止 `*`（S5）
12. 装 helmet；加限流（express-rate-limit）（S5）
13. 密钥走环境变量，`.env` 不进 git（S3）

## 韧性
14. 禁止空 catch；每个 catch 里有日志或上报（Q2/O1）
15. 所有外部调用（DB 写、外部 HTTP、支付）带 timeout；关键多步写操作包事务（Q2/D1）

## 测试与备份
16. 每个写接口（POST/PUT/DELETE）至少一个测试；`npm test` 必须绿（Q1）
17. 数据库有备份脚本 + 真实调度（crontab/CI schedule），并演练过一次恢复（D2）
