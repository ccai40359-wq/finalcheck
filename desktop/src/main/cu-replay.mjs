// 0.30.5 实验 3：录制回放（首次轨迹固化成 plan，第二次起零 LLM 回放）
// 依据（researcher 调研）：
// - UFO `FollowerSession`：读 plan 文件**确定性回放，不走 LLM**（官方文档，最接近的形态）
// - AgentRR：动作复用率 59.7%（LLM 生成模板）/ 77.3%（人工模板），延迟 4.5× 加速（38.0s→16.2s）
// - OS-Copilot/FRIDAY：`store_tool(name, code)` 把成功代码存进工具库（程序合成复用）
//
// 我们的形态（比 UFO 更保守）：
// - plan 里存「语义步骤」而不是绝对坐标：窗口 rect + 相对坐标（窗口挪了也能用）
// - 回放前校验：目标进程/window class/窗口尺寸是否匹配（不匹配就拒绝回放，退回 GUI 流程）
// - 每个记录下来的轨迹带 `verifiedAt`（哪次成功验证的）+ 断言（回放后要看什么）
// - 绝不静默回放：回放结果必须由调用方截图核对（plan 本身不知道界面变没变）

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** plan 的 schema 版本（结构变了就拒绝加载旧 plan） */
export const PLAN_SCHEMA = 2;

/**
 * 从一次成功的动作轨迹生成 plan（纯函数）。
 * @param {{ name:string, target:{process:string,title?:string,className?:string}, windowRect:{x,y,width,height}, steps:Array, assertion?:string }} input
 *   steps 里每步的 x/y 是**图内像素**（相对窗口左上角），不是屏幕绝对坐标——
 *   这样窗口移动后仍然可用（回放时用当前 windowRect 重新换算）。
 */
export function buildPlan(input) {
  const steps = Array.isArray(input?.steps) ? input.steps : [];
  if (!steps.length) return { ok: false, error: 'steps 不能为空' };
  const target = input?.target || {};
  if (!target.process) return { ok: false, error: 'target.process 必填（回放时用它校验目标还在不在）' };
  const rect = input?.windowRect;
  if (!rect || !Number.isFinite(Number(rect.width)) || !Number.isFinite(Number(rect.height))) {
    return { ok: false, error: 'windowRect 必填（记录相对坐标的基准）' };
  }
  const normalized = steps.map((s, i) => {
    const action = String(s?.action || '');
    const item = { action };
    if (Number.isFinite(Number(s?.x)) && Number.isFinite(Number(s?.y))) {
      item.x = Math.round(Number(s.x));
      item.y = Math.round(Number(s.y));
    }
    if (s?.text != null) item.text = String(s.text);
    if (s?.keys != null) item.keys = String(s.keys);
    if (s?.direction != null) item.direction = String(s.direction);
    if (s?.amount != null) item.amount = Number(s.amount);
    if (s?.waitMs != null) item.waitMs = Number(s.waitMs);
    return item;
  });
  return {
    ok: true,
    plan: {
      schema: PLAN_SCHEMA,
      name: String(input?.name || 'unnamed'),
      createdAt: new Date().toISOString(),
      target: {
        process: String(target.process),
        title: String(target.title || ''),
        className: String(target.className || '')
      },
      baseRect: { x: Number(rect.x) || 0, y: Number(rect.y) || 0, width: Number(rect.width), height: Number(rect.height) },
      steps: normalized,
      assertion: String(input?.assertion || ''),
      note: String(input?.note || '')
    }
  };
}

/**
 * 回放前校验：当前窗口状态是否还能用这份 plan（纯函数）。
 * 任何一项不匹配都拒绝回放——宁可退回 GUI 流程，也不要在错的位置乱点。
 * @returns {{ ok:boolean, reason?:string, detail?:string, scale?:{x:number,y:number} }}
 */
export function checkPlanReplay(plan, current) {
  if (!plan || plan.schema !== PLAN_SCHEMA) {
    return { ok: false, reason: 'schema-mismatch', detail: `plan schema ${plan?.schema} ≠ ${PLAN_SCHEMA}（结构变了，请重新录制）` };
  }
  const cur = current || {};
  if (!cur.process || String(cur.process).toLowerCase() !== String(plan.target.process).toLowerCase()) {
    return { ok: false, reason: 'target-process-changed', detail: `目标进程从「${plan.target.process}」变成了「${cur.process || '未知'}」` };
  }
  if (plan.target.className && cur.className && String(cur.className) !== String(plan.target.className)) {
    return { ok: false, reason: 'window-class-changed', detail: `窗口类名变了（${plan.target.className} → ${cur.className}），界面结构可能不同` };
  }
  const w = Number(cur.width); const h = Number(cur.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ok: false, reason: 'no-window-rect', detail: '拿不到当前窗口尺寸' };
  }
  // 尺寸偏差超过 15% 就认为布局可能变了（分辨率/DPI/缩放变化会让坐标失准）
  const dw = Math.abs(w - plan.baseRect.width) / plan.baseRect.width;
  const dh = Math.abs(h - plan.baseRect.height) / plan.baseRect.height;
  if (dw > 0.15 || dh > 0.15) {
    return {
      ok: false, reason: 'window-size-drift',
      detail: `窗口尺寸从 ${plan.baseRect.width}x${plan.baseRect.height} 变成 ${w}x${h}（偏差 ${Math.round(Math.max(dw, dh) * 100)}% > 15%）——布局可能变了，坐标会失准`
    };
  }
  if (cur.minimized === true) {
    return { ok: false, reason: 'window-minimized', detail: '目标窗口已最小化，回放需要窗口可见' };
  }
  // 尺寸有轻微差异（≤15%）→ 按比例缩放坐标
  return { ok: true, scale: { x: w / plan.baseRect.width, y: h / plan.baseRect.height } };
}

/** 把 plan 步骤换算成当前窗口下的屏幕坐标（纯函数） */
export function mapPlanStepsToScreen(plan, currentRect, scale = { x: 1, y: 1 }) {
  const rect = currentRect || plan.baseRect;
  return plan.steps.map((s, i) => {
    const out = { ...s, step: i + 1 };
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      out.screenX = Math.round(rect.x + s.x * (scale?.x || 1));
      out.screenY = Math.round(rect.y + s.y * (scale?.y || 1));
      out.imageX = Math.round(s.x * (scale?.x || 1));
      out.imageY = Math.round(s.y * (scale?.y || 1));
    }
    return out;
  });
}

/** plan 存储目录（默认 %APPDATA%/FinalCheck/cu-plans） */
export function planDir(dataRoot) {
  return path.join(String(dataRoot || '.'), 'cu-plans');
}

/** 保存 plan（落盘，文件名 = name + .json） */
export async function savePlan(dataRoot, plan) {
  const dir = planDir(dataRoot);
  await mkdir(dir, { recursive: true });
  const safeName = String(plan.name || 'unnamed').replace(/[^\w\u4e00-\u9fff.-]+/g, '_').slice(0, 60);
  const file = path.join(dir, `${safeName}.json`);
  await writeFile(file, JSON.stringify(plan, null, 2), 'utf8');
  return { ok: true, file };
}

/** 读取 plan（不存在/损坏 → 明确失败，不返回半个 plan） */
export async function loadPlan(dataRoot, name) {
  const dir = planDir(dataRoot);
  const safeName = String(name || '').replace(/[^\w\u4e00-\u9fff.-]+/g, '_').slice(0, 60);
  const file = path.join(dir, `${safeName}.json`);
  try {
    const raw = await readFile(file, 'utf8');
    const plan = JSON.parse(raw);
    if (!plan || plan.schema !== PLAN_SCHEMA) {
      return { ok: false, error: `plan schema 不匹配（${plan?.schema} ≠ ${PLAN_SCHEMA}），请重新录制` };
    }
    return { ok: true, plan, file };
  } catch (error) {
    return { ok: false, error: `读不到 plan「${name}」：${error?.message || error}` };
  }
}

/** 回放结果的说明（提醒调用方必须核对，不假装成功） */
export function replayResultNote({ planName, steps, scale }) {
  return [
    `已回放 plan「${planName}」的 ${steps.length} 个动作（确定性执行，没有经过模型推理）。`,
    scale && (scale.x !== 1 || scale.y !== 1)
      ? `窗口尺寸与录制时略有差异（缩放 ${scale.x.toFixed(3)}x${scale.y.toFixed(3)}），坐标已按比例换算。`
      : '',
    '回放只保证「动作按记录执行」，**不保证界面结果**——请截图核对预期变化（plan 里的断言：' + (planName ? '见 plan.assertion' : '无') + '）。'
  ].filter(Boolean).join(' ');
}
