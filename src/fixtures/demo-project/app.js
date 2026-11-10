// FinalCheck 演示项目：故意带洞、绝不联网、不监听端口。
//
// 这个文件只用于演示 FinalCheck 的 L1/L2 体检结果：
//   S1  未挂登录守卫的接口
//   S2  字符串拼接 SQL
//   S3  硬编码 API Key
//   S5  CORS 允许任意来源
//   H1  README 过短 + .env.example 缺变量
// 每一处洞的说明见 DEMO-README.md；不要把本项目部署到任何服务器。
//
// 安全设计：express 未安装时用同形桩对象；即使安装了 express，本文件也
// 不会调用 listen()。import 本文件只会构建路由表，不产生网络连接。

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// 演示项目故意不安装依赖（package.json 里写了 express，但没有 node_modules）。
// 有 express 就建一个真 app；没有就退回同形桩，保证 `node app.js` 与 import 都安全。
let express = null;
try {
  express = require('express');
} catch {
  express = null;
}

// 漏洞 S3：演示用假 Key。它不是任何真实服务的凭据，但写法就是硬编码。
const API_KEY = 'demo-hardcoded-key-123456';

// 漏洞 H1：代码读取 DB_PASSWORD，但 .env.example 只列了 PORT。
const dbPassword = process.env.DB_PASSWORD;

// .env.example 里有 PORT，这里也确实会读它。
const PORT = normalizePort(process.env.PORT);

// 演示用数据库桩：不连接任何真实数据库，也不会发起网络请求。
const db = {
  query(sql, params = []) {
    return Promise.resolve({ rows: [], sql, params });
  },
};

// 正确的对照写法：参数化查询 + 属主过滤。保留它只为让代码看起来像真实项目，
// 同时演示“同一个文件里既有危险写法也有安全写法”。
function selectOwnedUser(userId, id) {
  return db.query('SELECT id, name FROM users WHERE id = ? AND user_id = ?', [id, userId]);
}

export function normalizePort(value) {
  const port = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 3000;
}

// 本地 CORS 中间件桩：不需要安装 cors 包，也不会真的设置响应头。
function cors() {
  return function demoCors(_req, _res, next) {
    if (typeof next === 'function') next();
  };
}

// 对照用的登录守卫：真实项目里应当挂在这种位置。
function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  next();
}

function providerStatus() {
  return { configured: Boolean(API_KEY), dbConfigured: Boolean(dbPassword), port: PORT };
}

// 没有 express 时的同形桩：只记录注册了哪些路由，不执行处理函数。
function createStubApp() {
  const stack = [];
  const app = {
    use(...args) {
      stack.push({ method: 'use', args });
      return app;
    },
    get(routePath, ...handlers) {
      stack.push({ method: 'GET', path: routePath, handlers });
      return app;
    },
    post(routePath, ...handlers) {
      stack.push({ method: 'POST', path: routePath, handlers });
      return app;
    },
    listen() {
      throw new Error('演示项目禁止网络监听：不要调用 listen()');
    },
    get stack() {
      return stack;
    },
  };
  return app;
}

function registerRoutes(app) {
  // 漏洞 S5：CORS 不限制来源（L2 起应改成域名白名单）。
  app.use(cors({ origin: '*' }));

  // 正确的对照：这个接口挂了 requireAuth，S1 不会报它。
  app.get('/api/profile', requireAuth, (req, res) => {
    res.json({ user: req.user, status: providerStatus() });
  });

  // 漏洞 S1：带动态 id 的接口没有登录守卫，任何人都能访问。
  app.get('/api/users/:id', async (req, res) => {
    // 漏洞 S2.sqli-concat：把 req.params.id 直接拼进 SQL。
    const rows = await db.query('SELECT id, name FROM users WHERE id = ' + req.params.id);
    res.json(rows[0] || {});
  });
}

function buildApp() {
  if (!express) {
    const app = createStubApp();
    registerRoutes(app);
    return app;
  }
  const app = express();
  registerRoutes(app);
  return app;
}

// 导出 app 供测试与静态分析使用；import 时不会监听端口。
export const app = buildApp();

// 演示清单：测试和 DEMO-README 共用，避免两处说明漂移。
export const DEMO_CHECKS = Object.freeze([
  'S1: app.get("/api/users/:id") 没有登录守卫',
  'S2.sqli-concat: SQL 用字符串加号拼接 req.params.id',
  'S3.secret-literal: API_KEY 是硬编码字面量',
  'S5.cors-wildcard: CORS 允许任意来源',
  'H1.readme-short: README.md 少于 400 字符',
  'H1.env-sample-missing-vars: .env.example 缺 DB_PASSWORD',
  'S4: 没有 lockfile，依赖关会记为覆盖缺口（不是漏洞）',
]);

// 直接运行（npm start）时只打印说明；绝不调用 listen()。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  console.log('[finalcheck-demo] 这是故意带洞的演示项目，不会监听端口。');
  console.log('[finalcheck-demo] 用 FinalCheck 对它做 L1/L2 体检；详见 DEMO-README.md。');
}
