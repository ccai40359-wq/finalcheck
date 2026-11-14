---
name: fix-o1-ops
description: Use when audit 报 O1.no-backup / O1.no-ci / O1.ci-no-test / O1.docker-root / O1.docker-latest / O1.migration-no-down，或用户提到补健康检查、备份策略、CI 流水线、容器加固、迁移回退时加载。
description_en: Make the project ops-ready: health endpoint, backup script with restore drill, CI running tests, hardened Dockerfile, down migrations, then re-run the O1 gate.
---

# 运维就绪 (fix-o1-ops)

O1 检查「出了事有没有退路」：备份、健康检查、CI 测试、容器加固、迁移可回退。每一项都要能实际演练，不是文档里写一句话。

## 适用场景

- `O1.no-backup`：没有备份脚本或备份说明
- `O1.no-ci` / `O1.ci-no-test`：没有 CI 配置，或 CI 只构建不跑测试
- `O1.docker-root` / `O1.docker-latest`：镜像以 root 运行；生产 tag 用 latest
- `O1.migration-no-down`：数据库迁移只有 up 没有 down

## 修复步骤

1. 备份：可执行脚本 + README 写明恢复步骤：
   ```bash
   # scripts/backup.sh
   #!/usr/bin/env bash
   set -euo pipefail
   ts=$(date +%F-%H%M)
   mkdir -p backups
   docker exec db pg_dump -U app app | gzip > "backups/app-$ts.sql.gz"
   find backups -name '*.sql.gz' -mtime +14 -delete
   ```
   `chmod +x scripts/backup.sh`；crontab 加 `0 2 * * * /srv/app/scripts/backup.sh`；README 写明频率、保留天数与恢复命令（`gunzip -c backups/app-<ts>.sql.gz | psql -U app app`）。
2. 健康检查：服务暴露 /healthz（探到数据库），并接进编排探针：
   ```js
   app.get('/healthz', async (_req, res) => {
     try { await db.query('SELECT 1'); res.json({ ok: true }); }
     catch { res.status(503).json({ ok: false }); }
   });
   ```
   ```yaml
   # docker-compose.yml
   services:
     app:
       healthcheck:
         test: ["CMD", "curl", "-f", "http://localhost:3000/healthz"]
         interval: 30s
         timeout: 3s
         retries: 3
   ```
   日志：结构化输出（pino / structlog）带 level 与时间戳，stdout 交给收集器，别只写本地文件。
3. CI 跑测试（.github/workflows/ci.yml，GitLab 对应 .gitlab-ci.yml）：
   ```yaml
   name: ci
   on: [push, pull_request]
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 22, cache: npm }
         - run: npm ci
         - run: npm test
   ```
   测试步骤是硬要求，`npm ci` 后直接 build 仍会被 ci-no-test 判罚。
4. 容器加固：非 root + 固定版本 tag：
   ```dockerfile
   FROM node:22-slim
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --omit=dev && chown -R node:node /app
   COPY --chown=node:node . .
   USER node
   CMD ["node", "src/server.js"]
   ```
   compose / 部署清单里镜像写死具体版本（`postgres:16.4`、`redis:7.4`），不写 latest。
5. 迁移补 down（knex 示例，其他迁移工具同理）：
   ```js
   exports.up = async (knex) =>
     knex.schema.table('users', (t) => t.string('nickname'));
   exports.down = async (knex) =>
     knex.schema.table('users', (t) => t.dropColumn('nickname'));
   ```

## 验证

- 重跑 `finalcheck audit .` 确认 O1 归零：`O1.no-backup`、`O1.no-ci`、`O1.ci-no-test`、`O1.docker-root`、`O1.docker-latest`、`O1.migration-no-down` 条目全部消失
- 实测备份：`bash scripts/backup.sh` 产出 .sql.gz，并把恢复命令在临时库演练一遍成功导入
- 实测探针：`docker compose up -d` 后 `docker inspect --format '{{.State.Health.Status}}' <容器>` 为 healthy
- 实测镜像：`docker run --rm <image> whoami` 输出非 root 用户；CI 首次运行全绿（含 npm test 步骤）
- 实测迁移：`npm run migrate:down` 能回退最近一次迁移再 `migrate` 重新应用

## 陷阱

- 备份只有脚本没恢复演练：没验证过恢复的备份不是备份；至少一次 gunzip + psql 导入临时库确认可用
- healthcheck 探错端口：容器内服务监听 3000 却探 8080，永远 unhealthy 触发重启风暴；探针端口与实际监听对齐，探针打挂数据库依赖会误杀（/healthz 内做降级或探轻量依赖）
- CI 装依赖不跑测试：`npm ci && npm run build` 不算测试步骤，ci-no-test 照报；npm test / pytest 必须出现在工作流里
- USER node 写在依赖安装之前：后续步骤需要 root 写目录会构建失败，然后有人改回 root 运行——chown 与安装放 USER 之前，运行期保持非 root
- 迁移 down 写成空函数：`exports.down = async () => {}` 会被视为不可回退；dropColumn / dropTable 真实写回，数据迁移的 down 要能恢复原结构
