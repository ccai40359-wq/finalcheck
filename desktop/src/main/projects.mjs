// 项目文件夹（对齐 deepseek-harness / ZCode Projects）：
// 每个项目是磁盘上的真实目录，会话与项目记忆都在 <project>/.finalcheck/ 下；
// 全局只保存「项目列表」注册表（%APPDATA%/FinalCheck/projects.json）。
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const registryFile = () => process.env.FINALCHECK_PROJECTS_FILE || path.join(process.env.APPDATA || process.cwd(), 'FinalCheck', 'projects.json');

const defaultRoot = () => {
  if (process.env.FINALCHECK_DEFAULT_PROJECT) return path.resolve(process.env.FINALCHECK_DEFAULT_PROJECT);
  if (existsSync('D:\\')) return 'D:\\finalcheck';
  return path.join(process.env.USERPROFILE || process.cwd(), 'finalcheck');
};

const projectDataDir = (p) => path.join(p, '.finalcheck');
export const sessionDirOf = (p) => path.join(projectDataDir(p), 'sessions');
export const memoryDirOf = (p) => path.join(projectDataDir(p), 'memory');

async function readRegistry() {
  try {
    const j = JSON.parse(await readFile(registryFile(), 'utf8'));
    return { projects: Array.isArray(j?.projects) ? j.projects : [], activeProjectId: j?.activeProjectId || null };
  } catch {
    return { projects: [], activeProjectId: null };
  }
}

async function writeRegistry(reg) {
  const file = registryFile();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(reg, null, 2), 'utf8');
  await rename(tmp, file);
}

async function ensureDirs(p) {
  await mkdir(sessionDirOf(p), { recursive: true });
  await mkdir(memoryDirOf(p), { recursive: true });
}

export async function listProjects() {
  const reg = await readRegistry();
  return [...reg.projects].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function getProject(id) {
  const list = await listProjects();
  return list.find((p) => p.id === id) || null;
}

/** 上次选中的项目（重启后恢复） */
export async function getActiveProject() {
  const reg = await readRegistry();
  return reg.projects.find((p) => p.id === reg.activeProjectId) || null;
}

export async function setActiveProject(id) {
  const reg = await readRegistry();
  if (!reg.projects.some((p) => p.id === id)) return false;
  reg.activeProjectId = id;
  await writeRegistry(reg);
  return true;
}

export async function addProject(dir, { name, isDefault = false } = {}) {
  const root = path.resolve(String(dir || ''));
  const st = await stat(root).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error('项目目录不存在：' + root);
  const reg = await readRegistry();
  const exists = reg.projects.find((p) => path.resolve(p.path).toLowerCase() === root.toLowerCase());
  if (exists) {
    await ensureDirs(root);
    return exists;
  }
  const now = Date.now();
  const p = {
    id: randomUUID(),
    name: String(name || path.basename(root) || 'project').slice(0, 80),
    path: root,
    isDefault: !!isDefault,
    createdAt: now,
    updatedAt: now
  };
  await ensureDirs(root);
  reg.projects.push(p);
  await writeRegistry(reg);
  return p;
}

export async function ensureDefaultProject() {
  const list = await listProjects();
  const root = defaultRoot();
  const found = list.find((p) => path.resolve(p.path).toLowerCase() === path.resolve(root).toLowerCase());
  if (found) { await ensureDirs(found.path); return found; }
  await mkdir(root, { recursive: true });
  return addProject(root, { name: 'finalcheck', isDefault: true });
}

export async function removeProject(id) {
  const reg = await readRegistry();
  const before = reg.projects.length;
  reg.projects = reg.projects.filter((p) => p.id !== id);
  if (reg.projects.length === before) return false;
  if (reg.activeProjectId === id) delete reg.activeProjectId;
  await writeRegistry(reg);
  return true; // 只移除注册，不删除用户磁盘目录
}

export function defaultProjectRoot() { return defaultRoot(); }
