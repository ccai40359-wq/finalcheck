---
name: fix-s2-inject
description: Use when audit 报 S2.eval-dynamic / S2.sqli-concat / S2.cmdi（含 path-traversal、reflected-xss、ssrf），或用户提到动态 eval、SQL 拼接注入、命令注入怎么修时加载。
description_en: Fix dynamic eval, string-concatenated SQL, and shell command injection with explicit parsing, parameterized queries, and execFile argv arrays, then re-run the S2 gate.
---

# 注入修复 (fix-s2-inject)

三类注入对应三个固定改法：eval 改显式解析、SQL 改参数化、shell 改 execFile 数组参数。不要用过滤黑名单代替这些改法。

## 适用场景

- `S2.eval-dynamic`：`eval()` / `new Function()` / Python `eval()` 里拼了变量
- `S2.sqli-concat`：SQL 语句用模板字符串或 `+` 拼接用户输入
- `S2.cmdi`：`exec()` / `os.system()` / `shell=True` 执行了用户可控的命令串
- 关联规则同法可修：`S2.path-traversal`（路径拼参数）、`S2.reflected-xss`（响应回显未转义）、`S2.ssrf`（URL 拼用户输入）

## 修复步骤

1. eval 改显式解析——动态执行的每一种合法形态都有静态等价物：
   ```js
   // 改前
   const value = eval(`config.${key}`);
   // 改后：白名单 + 括号取值
   const ALLOWED_KEYS = new Set(['timeout', 'retries', 'host']);
   if (!ALLOWED_KEYS.has(key)) throw new Error(`bad config key: ${key}`);
   const value = config[key];
   ```
   Python 把表达式求值换成字面量解析：
   ```python
   import ast
   # 改前
   data = eval(expr)
   # 改后：只解字面量，不执行代码
   data = ast.literal_eval(expr)
   ```
2. SQL 参数化——值走占位符，任何库都不手拼：
   ```js
   // 改前
   db.query(`SELECT * FROM users WHERE name = '${req.query.name}'`);
   // 改后
   db.query('SELECT * FROM users WHERE name = ?', [req.query.name]);
   ```
   ```python
   # SQLAlchemy 2.x
   from sqlalchemy import text
   session.execute(text("SELECT * FROM users WHERE name = :n"), {"n": name})
   ```
   表名 / 排序列不能参数化，用白名单映射：
   ```js
   const SORTABLE = { created: 'created_at', name: 'name', id: 'id' };
   const col = SORTABLE[req.query.sort] ?? 'id';
   db.query(`SELECT * FROM users ORDER BY ${col} DESC`);
   ```
3. 命令注入改 execFile 数组参数，参数不经 shell：
   ```js
   // 改前
   exec(`convert ${uploadPath} -resize 200 out.png`);
   // 改后
   const { execFile } = require('node:child_process');
   await execFile('convert', [uploadPath, '-resize', '200', 'out.png'], { timeout: 30000 });
   ```
   Python：`os.system(f"...")`、`subprocess.run(cmd, shell=True)` 改成列表参数：
   ```python
   subprocess.run(["convert", upload_path, "-resize", "200", "out.png"], timeout=30, check=True)
   # 必须走 shell 时，参数逐个 shlex.quote
   ```
4. 路径穿越顺带修：`path.join(base, userInput)` 后 `path.resolve` 再断言在 base 内：
   ```js
   const p = path.resolve(base, req.params.file);
   if (!p.startsWith(base + path.sep)) throw new Error('path escape');
   ```
5. 改完跑受影响模块的单测，确认白名单/参数化没有改变合法请求的行为。

## 验证

- 重跑 `finalcheck audit .` 确认 S2 归零：`S2.eval-dynamic`、`S2.sqli-concat`、`S2.cmdi`（以及修到的 path-traversal / reflected-xss / ssrf）条目全部消失
- 渗透式自测：向相关接口塞 `' OR 1=1 --`、`; cat /etc/passwd`、`__import__('os').system('id')`，应被当作普通数据处理或报参数错误，不再产生执行效果
- 有安全用例就定向跑：`npm test -- inject` 或 `pytest -k injection`

## 陷阱

- 用清洗黑名单代替参数化：replace 掉引号分号挡不住编码、注释与嵌套引号；SQL 只有参数化一条正路，「过滤函数」只会制造虚假安全感
- execFile 仍拼整串：`execFile('sh', ['-c', \`convert ${file} out.png\`])` 等于没改——shell 还是吃到了拼接串；参数必须逐个数组元素，且 shell 关闭
- 白名单漏掉 SQL 列名 / 排序方向：`ORDER BY ${req.query.sort}` 和 `LIMIT ${n}` 同样是注入点；列名走映射表，数字用 `parseInt` 强转后校验
- ORM 的 raw / text() 里继续 f-string：`session.execute(text(f"... {name}"))` 依旧是注入，raw 查询也要绑定参数
- 修了一处忘了同文件其他处：同一查询构造器往往有多个拼接点，用 `grep -rnE "query\(\s*[\`\"]" src/` 把同类调用全过一遍
