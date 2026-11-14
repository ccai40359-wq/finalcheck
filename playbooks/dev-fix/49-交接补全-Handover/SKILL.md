---
name: fix-h1-handover
description: Use when audit 报 H1.readme-missing / H1.env-no-sample / H1.no-scripts / H1.no-deploy-clue / H1.readme-rollback-vague 等交接项，或用户提到补 README、.env.example、启动命令、部署与回滚说明时加载。
description_en: Complete the handover package: README quick start with runnable commands, .env.example, rollback and deploy instructions, then re-run the H1 gate.
---

# 交接补全 (fix-h1-handover)

H1 检查「新人拿到仓库能不能跑起来、出事能不能退回去」。所有命令必须真实可执行、样例不含真实值、回滚写到能照着敲的程度。

## 适用场景

- `H1.readme-missing` / `H1.readme-short` / `H1.readme-no-start-keyword`：README 缺失、过短，或没有可执行的启动说明
- `H1.env-no-sample` / `H1.env-sample-missing-vars` / `H1.env-sample-real-value`：环境变量没样例、样例键不全，或样例里写了真实值
- `H1.no-scripts` / `H1.command-missing-file` / `H1.command-missing-script`：README 引用的命令在 package.json 里不存在，或指向不存在的脚本文件
- `H1.readme-rollback-vague` / `H1.no-deploy-clue`：没有回滚说明、没有部署线索

## 修复步骤

1. 补 README 快速开始章节，命令逐条真实存在：
   ```markdown
   ## 快速开始
   npm install
   cp .env.example .env   # 填入你自己的密钥
   npm run dev            # 启动开发服务 http://localhost:3000
   ```
   对照 `node -e "console.log(require('./package.json').scripts)"` 逐条核对；缺的脚本补进 package.json（如 `"dev": "node src/server.js"`），而不是改 README 迁就现状。
2. 生成 .env.example：键名与代码实际读取的一致，值一律留空占位：
   ```bash
   grep -ohrE "process\.env\.[A-Z_]+" src/ --include="*.js" | sed 's/process\.env\.//' | sort -u > /tmp/keys.txt
   sed 's/$/=/' /tmp/keys.txt > .env.example
   ```
   Python 项目对照 `os.environ` / `os.getenv` / pydantic Settings 字段生成同样结构。手工检查一遍：任何真实密钥、真实密码都不能出现。
3. README 补部署与回滚章节，写到能照着敲：
   ```markdown
   ## 部署
   npm ci --omit=dev && npm run migrate && npm start
   # Docker: docker compose up -d --build

   ## 回滚
   docker compose down
   git revert <bad-commit> && docker compose up -d --build
   # 数据库：npm run migrate:down   （回退最近一次迁移）
   # 备份恢复：gunzip -c backups/app-<ts>.sql.gz | psql -U app app
   ```
   「联系运维」「用备份恢复一下」这类模糊话术会被 H1.readme-rollback-vague 继续判罚，必须落到具体命令。
4. README 引用的每个脚本 / 文件确认存在：
   ```bash
   grep -oE '`[a-zA-Z0-9_/.-]+\.(sh|py|mjs|js)`' README.md | tr -d '`' | while read f; do ls "$f" || echo "MISSING: $f"; done
   ```
   缺的要么补文件，要么改 README；`scripts/` 目录同理核对。
5. 若项目用 Python，补 requirements 说明与虚拟环境步骤：`python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`。

## 验证

- 重跑 `finalcheck audit .` 确认 H1 归零：readme-* / env-* / no-scripts / no-deploy-clue / rollback 相关条目全部消失
- 冷启动演练：换一个干净目录 `git clone <repo>`，严格按 README 快速开始逐步敲，服务应能起来；敲不通的命令就是漏改项
- 样例检查：`grep -E "sk-|AKIA|password=.+" .env.example` 不应出现真实形态的值（占位如 `=<your-key-here>` 可接受）
- 回滚演练（有条件时）：本地跑一遍 README 里的回滚命令，确认真的能退回上一版本

## 陷阱

- .env.example 直接 copy .env：真实密钥被写进仓库，H1.env-sample-real-value 会转成 S3.secret-literal 一起报；样例值一律留空或写 `<your-key-here>` 占位
- README 写了命令但 package.json 没有：H1.command-missing-* 照报；每条命令先跑通再写进文档，不允许「看起来对」
- 快速开始只有一句 `npm install && npm start`：缺 .env 配置步骤，新人必卡在密钥缺失；且没有明确的「启动」章节会被 readme-no-start-keyword 判罚
- 回滚说明只写「用备份恢复」：没有具体命令、备份位置、迁移回退方式等于没有；rollback-vague 不会归零
- 文档与代码漂移：README 写完不维护，下个迭代命令改了文档没改；把「README 命令跑通」放进 CI 或 code review 检查项
