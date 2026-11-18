// fc-media://local/<encodeURIComponent(绝对路径)>：右侧预览播放本地视频用的流式协议。
// 支持 Range（拖动进度条/跳转），不把整个视频读进内存；路径过同一道产物闸（敏感目录一律拒绝）。
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { assertArtifactPath } from './artifact-gate.mjs';
import { VIDEO_EXTS, parseRange } from './preview-convert.mjs';

export const MEDIA_SCHEME = 'fc-media';

/** 必须在 app ready 之前调用 */
export function registerMediaScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
}

export async function handleMediaRequest(request) {
  let abs;
  try { abs = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, '')); } catch { return new Response('bad url', { status: 400 }); }
  const gate = assertArtifactPath(abs);
  if (!gate.ok) return new Response('forbidden', { status: 403 });
  const ext = path.extname(gate.path).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return new Response('unsupported', { status: 415 });
  let st;
  try { st = await stat(gate.path); } catch { return new Response('not found', { status: 404 }); }
  if (!st.isFile()) return new Response('not found', { status: 404 });
  const headers = { 'Content-Type': VIDEO_EXTS.get(ext), 'Accept-Ranges': 'bytes' };
  const range = parseRange(request.headers.get('range'), st.size);
  if (range) {
    const body = Readable.toWeb(createReadStream(gate.path, { start: range.start, end: range.end }));
    return new Response(body, { status: 206, headers: { ...headers, 'Content-Length': String(range.end - range.start + 1), 'Content-Range': `bytes ${range.start}-${range.end}/${st.size}` } });
  }
  return new Response(Readable.toWeb(createReadStream(gate.path)), { status: 200, headers: { ...headers, 'Content-Length': String(st.size) } });
}

export function installMediaProtocol(protocol) {
  protocol.handle(MEDIA_SCHEME, (req) => handleMediaRequest(req));
}
