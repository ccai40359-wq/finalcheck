---
name: fix-s3-key
description: Use when 项目检出硬编码密钥需要轮换（S3.secret-literal / S3.private-key / S3.aws-key / S3.secret-value / S3.history-*），或用户提到撤销密钥、换 key、rotate secret、清 git 历史、.env 被 tracked 时加载。
description_en: Rotate leaked credentials end to end: revoke, reissue, purge git history, move secrets to .env + .gitignore, then re-run the S3 gate.
---

# 密钥轮换 (fix-s3-key)

检出硬编码密钥后的标准修复流：撤销 → 换新 → 清历史 → 收进 .env → 重跑 S3 gate。顺序不能乱：先撤销，其他步骤都是止损。

## 适用场景

- `S3.secret-literal` / `S3.secret-value`：源码里写死了 API key、数据库密码、token
- `S3.private-key` / `S3.aws-key`：私钥块、AWS AccessKeyId（AKIA 开头）直接出现在代码或配置里
- `S3.history-secret-literal` / `S3.history-private-key` / `S3.history-aws-key`：当前代码已删，但 git 历史里还能翻出旧值
- `S3.env-tracked`：.env 被提交进仓库；`S3.untracked-secret-file`：含密文件没进 .gitignore
- `S3.weak-default`：默认口令（admin/admin、secret、changeme）没改

## 修复步骤

1. 先撤销旧凭证，再谈其他。无论该 key 是否还在用，一律先到服务商后台吊销：
   - AWS：`aws iam delete-access-key --access-key-id AKIA...`（或控制台 IAM → Security credentials → Delete）
   - GitHub PAT：Settings → Developer settings → Personal access tokens → Delete
   - 数据库 / 第三方 SaaS：改密码并强制下线已有会话（轮换 JWT secret 会使全部旧 token 失效，属预期行为）
2. 签发新凭证，只进环境变量文件，不进代码：
   ```bash
   # .env（确认已被 .gitignore 忽略后再写入）
   DATABASE_URL=postgres://app:<新密码>@db.internal:5432/app
   OPENAI_API_KEY=sk-<新值>
   ```
3. 代码改为运行时读取，删掉所有字面量：
   ```js
   // 改前
   const client = new OpenAI({ apiKey: 'sk-hardcoded-value' });
   // 改后
   if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
   const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
   ```
   FastAPI / Python 场景用 pydantic-settings：
   ```python
   from pydantic_settings import BaseSettings
   class Settings(BaseSettings):
       openai_api_key: str
   settings = Settings()  # 从环境变量 / .env 注入
   ```
4. 清理 git 历史（不清理则 S3.history-* 不会归零）：
   ```bash
   pip install git-filter-repo
   echo 'sk-old-value==>REDACTED' > /tmp/replacements.txt
   git filter-repo --replace-text /tmp/replacements.txt --force
   git push --force --all && git push --force --tags
   ```
   也可用 BFG（`bfg --replace-text`）。强制推送前先通知所有协作者重新 clone，否则旧提交会被重新推回。
5. 补 .gitignore 与 .env.example：
   ```bash
   printf '.env\n*.pem\n*.key\n' >> .gitignore
   git rm --cached .env          # .env 曾被跟踪时必须先解除跟踪
   sed 's/=.*/=/' .env > .env.example   # 只留键名，值一律留空
   git add .gitignore .env.example && git commit -m "chore: secrets out of repo"
   ```
6. 全仓库确认无残留：
   ```bash
   grep -rnE "AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{20,}" --include="*.js" --include="*.py" --include="*.yaml" .
   ```
   命中任何一行就回到步骤 1 处理对应凭证。

## 验证

- 重跑 `finalcheck audit .` 确认 S3 归零：重点核对 `S3.secret-literal`、`S3.private-key`、`S3.aws-key`、`S3.env-tracked` 与全部 `S3.history-*` 条目消失
- 旧值失效验证：用旧 key 调一次服务商 API（如 `curl -H "Authorization: Bearer <旧key>" https://api.openai.com/v1/models`），应返回 401/403
- 新值生效验证：本地加载 .env 启动服务，走一遍用到该密钥的功能路径
- 仓库若另接 gitleaks / trufflehog，一并重跑确认 0 findings

## 陷阱

- 只换值不撤销旧密钥：旧 key 依然有效，等于没修。任何出现在代码或历史里的凭证，第一步永远是吊销，而不是先改代码
- 把密钥硬编码进测试或 .env.example：`expect(token).toBe('sk-真实值')` 会让 S3 重新报出；测试用明显是假的占位值（如 `test-key-0000`）或从环境变量注入并跳过用例
- 清历史后从旧 clone 推回：filter-repo 会改写提交号，协作者必须重新 clone；有人拿旧仓库 push 就会历史污染复发
- .gitignore 补在 .env 已提交之后：gitignore 对已跟踪文件无效，必须先 `git rm --cached .env` 再提交，否则 S3.env-tracked 不会归零
- 新密钥写进了 Dockerfile / docker-compose.yml 的环境变量段：构建参数会进镜像层与 compose 文件（通常入库），同样属于硬编码，应走运行时 env 或 secrets 管理
