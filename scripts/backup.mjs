#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile, unlink, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { findBinary } from '../src/which.mjs';

// 本地备份：%APPDATA%\FinalCheck 的 config/sessions/memory + 项目的 .finalcheck/finalcheck.db。
// 输出带时间戳的 zip；config.json 里的 key/token/secret 先脱敏再入包；默认保留最近 7 份。
// 不依赖第三方包：zip 容器用 Node 内置 zlib 写（store/deflate + central directory）。
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_KEEP = 7;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const SECRET_NAME_RE = /^(?:\.env(?:$|\.)|.*\.(?:pem|key|p12|pfx)$|id_rsa(?:$|\.)|credentials(?:$|\.)|secrets?(?:$|\.)|\.npmrc$|\.git-credentials$)/i;
const SECRET_KEY_RE = /(?:api[_-]?key|secret|token|pass(?:word|wd)|pwd|private[_-]?key|credential)/i;

function usage() {
  console.log(`用法: node scripts/backup.mjs [--out <目录>] [--profile <目录>] [--project <目录>] [--keep <份数>] [--no-db] [--dry-run]

默认:
  --out      ${path.join(os.homedir(), 'FinalCheck-Backups')}
  --profile  %APPDATA%\\FinalCheck（不存在则跳过）
  --project  当前仓库根目录（读取 .finalcheck/finalcheck.db）
  --keep     ${DEFAULT_KEEP}（只删本脚本生成的 finalcheck-backup-*.zip）`);
}

function parseArgs(argv) {
  const opts = { keep: DEFAULT_KEEP, dryRun: false, db: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--profile') opts.profile = argv[++i];
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--keep') opts.keep = Number(argv[++i]);
    else if (a === '--no-db') opts.db = false;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else throw new Error(`未知参数：${a}`);
  }
  if (!Number.isInteger(opts.keep) || opts.keep < 1) throw new Error('--keep 必须是 >=1 的整数');
  return opts;
}

function defaultProfileDir() {
  const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : null);
  return appData ? path.join(appData, 'FinalCheck') : path.join(os.homedir(), '.config', 'FinalCheck');
}

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// JSON 脱敏：密钥型键名一律替换；保留结构，便于恢复后重新在设置里填 key。
export function redactConfig(value) {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = '[REDACTED]';
      else out[k] = redactConfig(v);
    }
    return out;
  }
  return value;
}

// 文本兜底：会话/记忆里可能粘过工具输出；已知密钥前缀与常见 key 赋值一律抹掉。
export function scrubText(text) {
  return String(text)
    .replace(/(sk[-_][A-Za-z0-9_-]{8,}|pk_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,})/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|secret|token|pass(?:word|wd)|pwd|private[_-]?key|credential)\s*[:=]\s*['"])([^'"\s]{8,})(['"])/gi, '$1[REDACTED]$3')
    .replace(/((?:Authorization|Bearer)\s*:\s*Bearer\s+)([A-Za-z0-9._-]{8,})/gi, '$1[REDACTED]');
}

async function listFiles(root, rel = '', depth = 0) {
  if (depth > 8) return [];
  const dir = path.join(root, rel);
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (SECRET_NAME_RE.test(e.name)) continue;
    const abs = path.join(root, childRel);
    if (e.isDirectory()) { out.push(...await listFiles(root, childRel, depth + 1)); continue; }
    if (!e.isFile()) continue;
    const st = await stat(abs).catch(() => null);
    if (!st || st.size > MAX_FILE_BYTES) continue;
    out.push({ abs, rel: childRel, size: st.size });
  }
  return out;
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries, now = new Date()) {
  const dt = dosDateTime(now);
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, compressed);

    const cen = Buffer.alloc(46 + name.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dt.time, 12);
    cen.writeUInt16LE(dt.date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(compressed.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    name.copy(cen, 46);
    central.push(cen);

    offset += local.length + compressed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...central, end]);
}

async function backupSqlite(dbPath, destPath) {
  const sqlite3 = findBinary('sqlite3');
  if (sqlite3) {
    // sqlite3 CLI 的 .backup 是一致性快照（app 正在写也不会拿到半截页）。
    const r = sqlite3 ? spawnSync(sqlite3, [dbPath, '.backup', destPath], { encoding: 'utf8' }) : null;
    if (r && r.status === 0) return 'sqlite3';
  }
  await copyFile(dbPath, destPath);
  return 'copy';
}

async function addProfile(entries, profileDir, manifest) {
  const configPath = path.join(profileDir, 'config.json');
  if (existsSync(configPath)) {
    const raw = await readFile(configPath, 'utf8');
    let data;
    try { data = JSON.stringify(redactConfig(JSON.parse(raw)), null, 2); }
    catch { data = scrubText(raw); }
    entries.push({ name: 'profile/config.json', data });
    manifest.files.push({ path: 'profile/config.json', bytes: Buffer.byteLength(data), redacted: true });
    manifest.secretsRedacted.push('profile/config.json');
  }
  for (const dir of ['sessions', 'memory']) {
    const files = await listFiles(profileDir, dir);
    for (const f of files) {
      const raw = await readFile(f.abs);
      const isText = /\.(?:json|jsonl|md|txt|log|csv)$/i.test(f.abs);
      const data = isText ? scrubText(raw.toString('utf8')) : raw;
      const name = `profile/${f.rel}`;
      entries.push({ name, data });
      manifest.files.push({ path: name, bytes: Buffer.byteLength(data), redacted: isText });
    }
  }
}

async function addProjectDb(entries, projectDir, manifest) {
  const dbPath = path.join(projectDir, '.finalcheck', 'finalcheck.db');
  if (!existsSync(dbPath)) { manifest.skipped.push('.finalcheck/finalcheck.db (不存在)'); return; }
  const tmp = path.join(os.tmpdir(), `finalcheck-db-${process.pid}-${Date.now()}.db`);
  try {
    const mode = await backupSqlite(dbPath, tmp);
    const data = await readFile(tmp);
    entries.push({ name: 'project/finalcheck.db', data });
    manifest.files.push({ path: 'project/finalcheck.db', bytes: data.length, mode });
    manifest.dbMode = mode;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

async function pruneOld(outDir, keep) {
  let entries;
  try { entries = await readdir(outDir, { withFileTypes: true }); } catch { return []; }
  const zips = entries
    .filter((e) => e.isFile() && /^finalcheck-backup-\d{8}-\d{6}\.zip$/.test(e.name))
    .map((e) => e.name)
    .sort();
  const removed = [];
  while (zips.length > keep) {
    const name = zips.shift();
    await unlink(path.join(outDir, name)).catch(() => {});
    removed.push(name);
  }
  return removed;
}

export async function createBackup({ outDir, profileDir, projectDir, keep = DEFAULT_KEEP, includeDb = true, now = new Date() } = {}) {
  outDir = path.resolve(outDir || path.join(os.homedir(), 'FinalCheck-Backups'));
  profileDir = path.resolve(profileDir || defaultProfileDir());
  projectDir = path.resolve(projectDir || REPO_ROOT);
  const manifest = {
    format: 1,
    createdAt: now.toISOString(),
    zip: null,
    profile: path.basename(profileDir),
    files: [],
    skipped: [],
    secretsRedacted: [],
    dbMode: null,
  };
  const entries = [];
  if (existsSync(profileDir)) await addProfile(entries, profileDir, manifest);
  else manifest.skipped.push(`${path.basename(profileDir)} (profile 不存在)`);
  if (includeDb) await addProjectDb(entries, projectDir, manifest);
  else manifest.skipped.push('project/finalcheck.db (--no-db)');
  if (!entries.length) throw new Error('没有可备份的文件（profile 与项目数据库都不存在）');
  const zipName = `finalcheck-backup-${timestamp(now)}.zip`;
  manifest.zip = zipName;
  entries.unshift({ name: 'MANIFEST.json', data: JSON.stringify(manifest, null, 2) });
  const zip = buildZip(entries, now);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, zipName), zip);
  const removed = await pruneOld(outDir, keep);
  return { zipPath: path.join(outDir, zipName), manifest, removed, bytes: zip.length };
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); usage(); process.exit(2); }
  const outDir = path.resolve(opts.out || path.join(os.homedir(), 'FinalCheck-Backups'));
  const profileDir = path.resolve(opts.profile || defaultProfileDir());
  const projectDir = path.resolve(opts.project || REPO_ROOT);
  if (opts.dryRun) {
    console.log(`[dry-run] profile=${profileDir} project=${projectDir} out=${outDir} keep=${opts.keep} db=${opts.db}`);
    return;
  }
  try {
    const res = await createBackup({ outDir, profileDir, projectDir, keep: opts.keep, includeDb: opts.db });
    console.log(`备份完成：${res.zipPath}`);
    console.log(`  文件 ${res.manifest.files.length} 个 / ${res.bytes} 字节 / 数据库 ${res.manifest.dbMode || '未包含'} / 配置脱敏 ${res.manifest.secretsRedacted.length} 个`);
    if (res.removed.length) console.log(`  清理旧备份 ${res.removed.length} 个（保留 ${opts.keep} 份）`);
  } catch (e) {
    console.error(`备份失败：${e.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
