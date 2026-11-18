// 右侧预览：Office 文档（PPT/Word）→ PDF，交给渲染层的分页查看器一页一页地看。
// 用本机 LibreOffice 无界面转换；结果按「路径 + 修改时间 + 大小」缓存，同一文件只转一次。
// 没装 LibreOffice 时返回明确原因（渲染层提示安装或「外部打开」），不假装能预览。
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const OFFICE_EXTS = new Set(['.pptx', '.ppt', '.pps', '.ppsx', '.odp', '.key', '.docx', '.doc', '.odt', '.rtf']);
export const VIDEO_EXTS = new Map([
  ['.mp4', 'video/mp4'], ['.m4v', 'video/mp4'], ['.webm', 'video/webm'], ['.mov', 'video/quicktime'], ['.ogv', 'video/ogg'],
]);
const CONVERT_TIMEOUT_MS = 180000;

export function findSoffice({ env = process.env, exists = existsSync } = {}) {
  const c = [];
  if (env.FINALCHECK_SOFFICE) c.push(env.FINALCHECK_SOFFICE);
  if (process.platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean)) {
      c.push(path.join(base, 'LibreOffice', 'program', 'soffice.exe'));
    }
  } else if (process.platform === 'darwin') {
    c.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  } else {
    c.push('/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice');
  }
  return c.find((p) => exists(p)) || null;
}

const inflight = new Map(); // 同一文件并发点开只转一次

/**
 * @returns {Promise<{ok:true, pdfPath:string, cached:boolean} | {ok:false, reason:string}>}
 */
export async function officeToPdf(abs, { cacheDir, soffice = findSoffice(), runner = runSoffice } = {}) {
  if (!soffice) return { ok: false, reason: 'no-libreoffice' };
  const st = await stat(abs);
  const key = createHash('sha1').update(`${abs}|${st.mtimeMs}|${st.size}`).digest('hex').slice(0, 16);
  const out = path.join(cacheDir, `${key}.pdf`);
  if (existsSync(out)) return { ok: true, pdfPath: out, cached: true };
  if (inflight.has(out)) return inflight.get(out);
  const job = (async () => {
    const work = path.join(cacheDir, `work-${key}`);
    await mkdir(work, { recursive: true });
    // 独立配置目录：用户正开着 LibreOffice 时，共用配置会让无界面转换直接失败
    const profile = pathToFileURL(path.join(cacheDir, 'lo-profile')).href;
    const r = await runner(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--nolockcheck', '--convert-to', 'pdf', '--outdir', work, abs], CONVERT_TIMEOUT_MS);
    const produced = (await readdir(work).catch(() => [])).find((f) => f.toLowerCase().endsWith('.pdf'));
    if (!produced) {
      await rm(work, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: r.timedOut ? 'timeout' : `convert-failed${r.stderr ? `: ${String(r.stderr).trim().split('\n').pop().slice(0, 160)}` : ''}` };
    }
    await rename(path.join(work, produced), out);
    await rm(work, { recursive: true, force: true }).catch(() => {});
    return { ok: true, pdfPath: out, cached: false };
  })().finally(() => inflight.delete(out));
  inflight.set(out, job);
  return job;
}

function runSoffice(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let stderr = '';
    let timedOut = false;
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* 已退出 */ } }, timeoutMs);
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: null, stderr: e.message, timedOut }); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stderr, timedOut }); });
  });
}

/** 解析 HTTP Range 头（视频拖动进度条要用）。返回 {start,end} 或 null（无/非法 → 整段）。 */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start; let end;
  if (!m[1]) { start = Math.max(0, size - Number(m[2])); end = size - 1; } // bytes=-500：最后 500 字节
  else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (start > end || start >= size) return null;
  return { start, end };
}
