---
name: fix-s1-guard
description: Use when audit 报 S1.no-guard（接口无登录守卫），或用户提到路由鉴权、未授权访问、给路由加登录校验、登记 publicRoutes 白名单时加载。
description_en: Fix unauthenticated routes: add login guard middleware, register genuinely public endpoints in finalcheck.config.json publicRoutes, then re-run the S1 gate.
---

# 路由鉴权 (fix-s1-guard)

S1.no-guard 的修复只有两个正当动作：真公开接口登记 publicRoutes 白名单；其余一律补登录守卫。白名单是声明，不是消红手段。

## 适用场景

- `S1.no-guard`：audit 扫出的业务路由没有 requireAuth / 登录守卫中间件
- 报告建议里写「挂登录守卫中间件；确属公开接口，登记进 finalcheck.config.json 的 publicRoutes」时，按本技能二选一处理
- 新增接口忘了挂守卫、重构时守卫中间件被挪走等回归场景

## 修复步骤

1. 拿到清单并逐条定性。先看报告里的 S1.no-guard 条目（或 `finalcheck audit . --json` 过滤 rule），对每条路由判断：健康检查 / 登录页 / webhook → 可登记；/api/orders、/admin、/users 这类业务接口 → 必须补守卫。
2. 非公开接口补守卫。Express 全局中间件 + 显式放行名单（注意：必须在路由注册之前挂）：
   ```js
   const PUBLIC = ['/healthz', '/login', '/docs'];
   app.use((req, res, next) => {
     if (PUBLIC.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
     if (req.method === 'OPTIONS') return next();          // CORS 预检放行
     if (!req.session?.user) return res.status(401).json({ error: 'unauthorized' });
     next();
   });
   app.use('/api', apiRouter);   // 中间件写在它前面才生效
   ```
   FastAPI 用依赖注入：
   ```python
   from fastapi import Depends, HTTPException
   def require_user(token: str = Depends(oauth2_scheme)) -> User:
       user = decode_token(token)
       if not user:
           raise HTTPException(status_code=401, detail="unauthorized")
       return user
   @router.get("/orders", dependencies=[Depends(require_user)])
   async def list_orders(): ...
   ```
3. 路由级守卫也可以直接写在路由参数里，路由提取器会识别含 auth / login / session / jwt / guard 等关键词的守卫名为有效守卫：
   ```js
   router.get('/me', requireAuth, getUser);        // requireAuth 被认定为守卫
   ```
4. 确属公开的接口，登记进项目根的 finalcheck.config.json：
   ```json
   {
     "publicRoutes": ["/healthz", "/webhooks/github", "/docs", "/public/*"]
   }
   ```
   只登记真实公开的路由；支持 `*` / `/**` 通配与前缀匹配。登记前逐条想一遍「匿名能访问它造成什么损失」。
5. 自查有没有漏网路由：
   ```bash
   grep -rnE "\.(get|post|put|delete|patch)\(" src/ --include="*.js" | grep -vE "requireAuth|authenticate|checkLogin|/healthz|/login"
   ```
   输出里的每条路由要么已挂守卫，要么已登记白名单，否则继续处理。

## 验证

- 重跑 `finalcheck audit .` 确认 S1 归零：S1.no-guard 条目全部消失
- 匿名冒烟：`curl -i http://localhost:3000/api/orders` 应 401；带 token / session 再请求应 200
- 白名单回归：`curl -i http://localhost:3000/healthz` 匿名仍 200，没把登录页、探活接口也拦死
- 跑一遍现有鉴权相关测试：`npm test -- auth`（有 pytest 则 `pytest tests/test_auth.py`）

## 陷阱

- 把受保护接口图省事塞进 publicRoutes：白名单语义是「确认公开」，/admin、/api/users 登记进去等于裸奔；S1 归零但越权风险真实存在
- 守卫中间件挂在路由注册之后：Express 按注册顺序执行，`app.use(auth)` 写在 `app.use('/api', router)` 后面对 API 完全无效；这是最常见的「明明加了守卫还在报」
- 只挡页面不挡 API：前端路由有跳转、/api/* 裸奔是典型漏网；S1 扫的就是接口，逐条对齐报告清单
- OPTIONS / 探活被 401 拦截：CORS 预检和 /healthz 被拦会导致跨域全挂、容器探活失败重启风暴；放行要精确到具体路径，别顺手放行整个 /api
- 守卫名不起眼导致识别失效：路由提取器按守卫名关键词判定，`router.get('/x', mw, h)` 这种无语义命名的中间件可能不被认定为守卫；守卫函数名带 auth / login / session 字样
