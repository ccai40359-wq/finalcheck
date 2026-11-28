// 0.34.7 显卡信息：启动后第一次用到时查一次 nvidia-smi，结果缓存到进程结束。
// 每回合写进「运行环境」那条说明里，模型不用自己再去查，跑本地模型时直接选 GPU 版本。
// 只放不会变的（型号 + 总显存），不放剩余显存：这条在上下文前部，每回合变一次会让前缀缓存失效。
import { execFile } from 'node:child_process';

let cached = null; // Promise<{ gpus: Array<{ name, memMiB }>, driver, cuda } | null>

function runSmi(args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile('nvidia-smi', args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout || '')));
    } catch { resolve(null); }
  });
}

/** 解析 `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits` 的输出 */
export function parseGpuCsv(text) {
  const gpus = [];
  let driver = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 2 || !cols[0]) continue;
    const memMiB = Number(cols[1]);
    gpus.push({ name: cols[0], memMiB: Number.isFinite(memMiB) ? memMiB : 0 });
    if (!driver && cols[2]) driver = cols[2];
  }
  return gpus.length ? { gpus, driver } : null;
}

/** 查一次，之后复用；查不到 / 没 N 卡 / 超时都返回 null */
export function getGpuInfo({ timeoutMs = 4000 } = {}) {
  if (!cached) {
    cached = runSmi(['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], timeoutMs)
      .then((out) => parseGpuCsv(out))
      .catch(() => null);
  }
  return cached;
}

/** 测试用 */
export function _resetGpuInfo(value = null) { cached = value ? Promise.resolve(value) : null; }

/** 「运行环境」里的显卡那一句 */
export function gpuLine(info) {
  if (!info || !Array.isArray(info.gpus) || !info.gpus.length) {
    return '显卡：没检测到 NVIDIA 显卡——本地模型用 CPU 版（有核显 / AMD 卡时可考虑 DirectML 版）。';
  }
  const list = info.gpus.map((g) => `${g.name}${g.memMiB ? `（${Math.round(g.memMiB / 1024)}GB 显存）` : ''}`).join('、');
  return `显卡：${list}，CUDA 可用——跑本地模型（OCR / 语音识别 / LLM / 图像生成 / 视频转码）默认用 GPU 版本（torch/paddle 装 CUDA 版、onnxruntime-gpu、ffmpeg 用 h264_nvenc），不用 CPU 版慢慢磨。`;
}
