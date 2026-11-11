import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { listTextFiles, readRel } from '../walk.mjs';

// O1 运维就绪（L3 静态闸）
//
// 全部只读文本，不执行任何命令。覆盖四件事：
//   1) Dockerfile（根目录或 docker/）：USER 缺失 / USER root → high；FROM :latest → low
//   2) CI（.github/workflows/*.yml|yaml 或 .gitlab-ci.yml）：存在但无测试步骤 → medium；
//      完全没有 CI → medium
//   3) 数据库迁移（migrations/ 或 db/migrate/）：无 down/rollback/revert 语义 → medium；
//      没有迁移目录不报，只记 warning
//   4) 备份/恢复：全仓找不到 backup/restore/restore-drill 脚本或文档关键字 → low（仅 L3 计分）
const CI_TEST_RE = /\b(?:npm\s+(?:run\s+)?test|npm\s+ci|yarn\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|pytest|go\s+test|mvnw?\s+test|gradlew?\s+test|dotnet\s+test|cargo\s+test|phpunit|vitest|jest)\b/i;
const DOCKER_LATEST_RE = /:latest$/i;
const BACKUP_NAME_RE = /(?:backup|restore)/i;
const BACKUP_TEXT_RE = /\b(?:backup|backups|backuped|backing|restore|restores|restored|restore-drill)\b|备份|恢复|灾备|演练/i;
// 关键字只认「脚本/文档/配置」；测试源码里为了断言而写的 backup 字样不算运维证据
const BACKUP_TEXT_EXT_RE = /\.(?:md|markdown|txt|rst|adoc|sh|bash|ps1|bat|cmd|yml|yaml|toml|ini|conf|cfg|env|sql|service|timer)$/i;
// 迁移回滚语义：优先认文件名（001_down.sql / rollback_x.sql），再兜底常见语言的方法名
const MIGRATION_DOWN_NAME_RE = /(?:^|[_.\-\s])(?:down|rollback|revert)(?:[_.\-\s]|$)/i;
const MIGRATION_DOWN_CONTENT_RE = /\bdef\s+(?:self\.)?(?:down|rollback)\b|\bexports?\.(?:down|rollback)\s*=|\b(?:down|rollback|revert)\s*:\s*(?:async\s*)?(?:function\s*)?\(|\b(?:rollback|revert)\s*\(/i;

const isExcluded = (rel, excludes) => {
  const r = String(rel || '').replace(/\\/g, '/');
  return (Array.isArray(excludes) ? excludes : []).some((x) => {
    const n = String(x || '').replace(/\\/g, '/');
    return r === n || r.startsWith(n + '/');
  });
};

async function isDirectory(p) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

async function isFile(p) {
  try { return (await stat(p)).isFile(); } catch { return false; }
}

async function readText(abs) {
  try {
    const st = await stat(abs);
    if (!st.isFile() || st.size > 512 * 1024) return null; // 与 walk 层一致：超大文件不读
    return await readFile(abs, 'utf8');
  } catch { return null; }
}

/** 根目录 + docker/ 下的 Dockerfile（含 Dockerfile.prod / *.dockerfile 这类常见命名） */
async function findDockerfiles(projectDir, excludes) {
  const out = new Set();
  const collect = async (dirRel) => {
    const abs = path.join(projectDir, dirRel);
    let entries;
    try { entries = await readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/^Dockerfile(?:\.|$)/i.test(e.name) && !/\.dockerfile$/i.test(e.name)) continue;
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (!isExcluded(rel, excludes)) out.add(rel);
    }
  };
  await collect('');
  await collect('docker');
  return [...out].sort();
}

/** 返回 { user: {value,line}|null, userLine, latestLines }，只看最后一个 FROM 之后的最终阶段 */
function inspectDockerfile(text) {
  const lines = String(text || '').split(/\r?\n/);
  let lastFrom = -1;
  const latestLines = [];
  const users = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const from = /^FROM\s+(.+)$/i.exec(trimmed);
    if (from) {
      lastFrom = i;
      // 跳过 --platform=... 这类 flag，image 取第一个非 flag token
      const image = from[1].trim().split(/\s+/).find((x) => !x.startsWith('--')) || '';
      if (DOCKER_LATEST_RE.test(image)) latestLines.push(i + 1);
      continue;
    }
    const user = /^USER\s+(.+)$/i.exec(trimmed);
    if (user) {
      const value = user[1].trim().replace(/\s+#.*$/, '').trim();
      users.push({ value, line: i + 1 });
    }
  }
  // Docker 只认最终阶段的 USER；忽略早期 builder 阶段的 USER
  const effective = users.filter((u) => u.line > lastFrom + 1);
  return { user: effective.length ? effective[effective.length - 1] : null, latestLines };
}

const isRootUser = (value) => /^(?:root|0)(?::(?:root|0))?$/i.test(String(value || '').trim());

async function findCiFiles(projectDir, excludes) {
  const out = [];
  if (!isExcluded('.gitlab-ci.yml', excludes) && await isFile(path.join(projectDir, '.gitlab-ci.yml'))) {
    out.push('.gitlab-ci.yml');
  }
  const wfDir = path.join(projectDir, '.github', 'workflows');
  let entries = [];
  try { entries = await readdir(wfDir, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (!e.isFile() || !/\.(?:yml|yaml)$/i.test(e.name)) continue;
    const rel = `.github/workflows/${e.name}`;
    if (!isExcluded(rel, excludes)) out.push(rel);
  }
  return out.sort();
}

async function findMigrationDirs(projectDir, excludes) {
  const out = [];
  for (const rel of ['migrations', 'db/migrate']) {
    if (isExcluded(rel, excludes)) continue;
    if (await isDirectory(path.join(projectDir, rel))) out.push(rel);
  }
  return out;
}

async function walkFiles(projectDir, dirRel, depth = 0) {
  const out = [];
  if (depth > 4) return out;
  let entries;
  try { entries = await readdir(path.join(projectDir, dirRel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = `${dirRel}/${e.name}`.replace(/\\/g, '/');
    if (e.isDirectory()) out.push(...await walkFiles(projectDir, rel, depth + 1));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

async function migrationHasDown(projectDir, dirRel) {
  const files = await walkFiles(projectDir, dirRel);
  for (const rel of files) {
    if (MIGRATION_DOWN_NAME_RE.test(path.basename(rel))) return true;
    const abs = path.join(projectDir, rel);
    let st;
    try { st = await stat(abs); } catch { continue; }
    if (st.size > 512 * 1024) continue; // 超大文件不做内容兜底
    const text = await readText(abs);
    if (text != null && MIGRATION_DOWN_CONTENT_RE.test(text)) return true;
  }
  return false;
}

/** 备份/恢复：文件名命中（backup*.sh / restore-drill.md）或文本关键字命中 */
async function hasBackupArtifacts(projectDir, excludes, includeFixtures) {
  const { files, skipped } = await listTextFiles(projectDir, excludes, { includeFixtures });
  for (const abs of files) {
    const rel = path.relative(projectDir, abs).replace(/\\/g, '/');
    if (BACKUP_NAME_RE.test(path.basename(rel))) return { found: true, evidence: rel, skipped };
    if (!BACKUP_TEXT_EXT_RE.test(rel) && !/^\.env($|\.)/i.test(path.basename(rel))) continue;
    const { text } = await readRel(projectDir, abs);
    if (BACKUP_TEXT_RE.test(text)) return { found: true, evidence: rel, skipped };
  }
  return { found: false, evidence: null, skipped };
}

export async function checkOps(projectDir, { tier, excludes = [], includeFixtures = false } = {}) {
  const findings = [];
  const warnings = [];
  const t = String(tier || 'L3').toUpperCase();
  const forceFor = (severity) => (t === 'L3' ? 'card' : severity === 'low' ? 'tip' : 'check');
  const push = (severity, file, line, rule, snippet, message) => findings.push({
    checkId: 'O1', severity, force: forceFor(severity), file, line: Number(line) || 0, rule, snippet, message, source: 'program'
  });

  // 1) Dockerfile：非 root 是硬要求；:latest 只提醒
  const dockerfiles = await findDockerfiles(projectDir, excludes);
  for (const rel of dockerfiles) {
    const text = await readText(path.join(projectDir, rel));
    if (text == null) { warnings.push(`无法读取 ${rel}，容器用户检查跳过`); continue; }
    const { user, latestLines } = inspectDockerfile(text);
    if (!user) {
      push('high', rel, 0, 'O1.docker-root', `${rel} 无 USER 指令`,
        'Dockerfile 缺少 USER 指令，容器默认以 root 运行；请显式切换到非 root 用户');
    } else if (isRootUser(user.value)) {
      push('high', rel, user.line, 'O1.docker-root', `USER ${user.value}`,
        'Dockerfile 最终阶段以 root 运行；请改用非 root 用户');
    }
    for (const line of latestLines) {
      push('low', rel, line, 'O1.docker-latest', 'FROM ...:latest',
        'Dockerfile 使用 :latest 标签，构建不可复现，建议固定版本/摘要');
    }
  }

  // 2) CI：存在但无测试步骤 = medium；完全没有 CI = medium
  const ciFiles = await findCiFiles(projectDir, excludes);
  if (!ciFiles.length) {
    push('medium', '(仓库根)', 0, 'O1.no-ci',
      '.github/workflows 与 .gitlab-ci.yml 均未发现',
      '未发现 CI 配置：交付缺少可复现的自动化验证记录');
  } else {
    let hasTest = false;
    let readable = 0;
    for (const rel of ciFiles) {
      const text = await readText(path.join(projectDir, rel));
      if (text == null) { warnings.push(`无法读取 CI 文件 ${rel}`); continue; }
      readable++;
      if (CI_TEST_RE.test(text)) hasTest = true;
    }
    if (readable === 0) {
      warnings.push('CI 配置文件均无法读取，测试步骤检查未完成');
    } else if (!hasTest) {
      push('medium', ciFiles[0], 0, 'O1.ci-no-test', `已检查 ${readable} 个 CI 文件，未发现测试步骤`,
        'CI 配置存在但没有测试步骤（npm test / npm ci / pytest / go test / mvn test 任一）');
    }
  }

  // 3) 迁移回滚：没有迁移目录不报（只 warning）
  const migrationDirs = await findMigrationDirs(projectDir, excludes);
  if (!migrationDirs.length) {
    warnings.push('未发现 migrations/ 或 db/migrate/ 目录，迁移回滚检查未执行');
  } else {
    for (const dir of migrationDirs) {
      if (!await migrationHasDown(projectDir, dir)) {
        push('medium', dir, 0, 'O1.migration-no-down', `${dir} 无 down/rollback 语义`,
          '数据库迁移目录里没有 down/rollback/revert 语义文件名或回滚方法，无法回滚');
      }
    }
  }

  // 4) 备份/恢复：只在 L3 计分（L2 不产生 finding）
  const backup = await hasBackupArtifacts(projectDir, excludes, includeFixtures);
  if (backup.skipped?.length) {
    warnings.push(`备份/恢复扫描跳过 ${backup.skipped.length} 个大文件（>512KB）`);
  }
  if (!backup.found) {
    if (t === 'L3') {
      push('low', '(全仓搜索)', 0, 'O1.no-backup', '未发现 backup/restore 脚本或文档关键字',
        '未发现备份/恢复脚本或演练记录（L3 计分）');
    } else {
      warnings.push('未发现备份/恢复脚本或文档关键字（仅 L3 计分）');
    }
  }

  return { checkId: 'O1', findings, coverageGap: null, warnings };
}
