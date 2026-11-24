// 设置 → Hooks（0.33.1，对齐 Claude Code 的 hooks 设置）
// 配置就是 hooks.json（%APPDATA%/FinalCheck/hooks.json）：总开关 + 七个事件，每个事件下若干条 { matcher, command, timeoutMs }。
// 每条都能「试跑」：用这个事件的示例输入真跑一次，看退出码、输出和判定（deny / ask / allow）。
import React, { useEffect, useState } from 'react';
import { api, Card, ErrorNote } from '../lib/ui.jsx';
import { t } from '../i18n/core.mjs';

const EVENT_INFO = {
  SessionStart: { desc: '新会话开始时（可往上下文里塞项目约定）', matcher: '来源，如 startup' },
  UserPromptSubmit: { desc: '你发出消息前（可拦截或补充上下文；失败按拒绝处理）', matcher: '按提示词文本匹配的正则' },
  PreToolUse: { desc: '每次工具调用前（可拒绝 / 要求确认 / 改参数；失败按拒绝处理）', matcher: '工具名正则，如 run_command|write_file' },
  PermissionRequest: { desc: '弹审批之前（返回 allow / deny 可代替你决定）', matcher: '工具名正则' },
  PostToolUse: { desc: '工具成功之后（如改完文件自动格式化）', matcher: '工具名正则，如 edit_file|write_file' },
  PostToolUseFailure: { desc: '工具失败之后（记录 / 通知）', matcher: '工具名正则' },
  Stop: { desc: '一轮回复结束时（如发通知）', matcher: '按回复文本匹配的正则' }
};

const toList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v])
  .map((h) => (typeof h === 'string' ? { matcher: '', command: h, timeoutMs: '' } : { matcher: h?.matcher || '', command: h?.command || '', timeoutMs: h?.timeoutMs ?? '' }));

export default function HooksSettings() {
  const y = api();
  const [file, setFile] = useState('');
  const [events, setEvents] = useState(Object.keys(EVENT_INFO));
  const [enabled, setEnabled] = useState(false);
  const [lists, setLists] = useState({});
  const [extra, setExtra] = useState({}); // 原配置里的其它字段（timeoutMs / maxOutputBytes）原样保留
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [warnings, setWarnings] = useState([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [tests, setTests] = useState({}); // `${event}:${i}` → { running, result }

  useEffect(() => {
    let alive = true;
    y?.hooksGet?.().then((r) => {
      if (!alive || !r) return;
      setFile(r.file || '');
      if (Array.isArray(r.events) && r.events.length) setEvents(r.events);
      const c = r.config || {};
      setEnabled(c.enabled === true);
      const { enabled: _e, events: ev, ...rest } = c;
      setExtra(rest);
      const l = {};
      for (const name of Object.keys(ev || {})) l[name] = toList(ev[name]);
      setLists(l);
      setWarnings(r.warnings || []);
    }).catch(() => {});
    return () => { alive = false; };
  }, [y]);

  const touch = () => { setDirty(true); setSaved(false); };
  const update = (ev, i, patch) => { setLists((l) => ({ ...l, [ev]: (l[ev] || []).map((h, j) => (j === i ? { ...h, ...patch } : h)) })); touch(); };
  const addHook = (ev) => { setLists((l) => ({ ...l, [ev]: [...(l[ev] || []), { matcher: '', command: '', timeoutMs: '' }] })); touch(); };
  const removeHook = (ev, i) => { setLists((l) => ({ ...l, [ev]: (l[ev] || []).filter((_, j) => j !== i) })); touch(); };

  const build = () => {
    const out = { ...extra, enabled, events: {} };
    for (const ev of events) {
      const hooks = (lists[ev] || []).filter((h) => h.command.trim()).map((h) => ({
        command: h.command.trim(),
        ...(h.matcher.trim() ? { matcher: h.matcher.trim() } : {}),
        ...(Number(h.timeoutMs) > 0 ? { timeoutMs: Number(h.timeoutMs) } : {})
      }));
      if (hooks.length) out.events[ev] = hooks;
    }
    return out;
  };

  const badMatcher = (m) => { if (!m) return false; try { new RegExp(m); return false; } catch { return true; } };
  const invalid = events.some((ev) => (lists[ev] || []).some((h) => badMatcher(h.matcher.trim())));

  const save = async () => {
    setSaving(true); setError('');
    try {
      const r = await y.hooksSave(build());
      if (!r?.ok) setError(r?.error || t('保存失败'));
      else { setDirty(false); setSaved(true); setWarnings(r.warnings || []); }
    } catch (e) { setError(String(e?.message || e)); }
    setSaving(false);
  };

  const runTest = async (ev, i) => {
    const key = `${ev}:${i}`;
    setTests((s) => ({ ...s, [key]: { running: true } }));
    try {
      const r = await y.hooksTest({ event: ev, hook: lists[ev][i] });
      setTests((s) => ({ ...s, [key]: { result: r } }));
    } catch (e) {
      setTests((s) => ({ ...s, [key]: { result: { error: String(e?.message || e) } } }));
    }
  };

  const total = events.reduce((n, ev) => n + (lists[ev] || []).filter((h) => h.command.trim()).length, 0);

  return (
    <div className="space-y-4">
      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-ink font-medium">{t('启用 Hooks')}</div>
            <div className="text-xs text-mute mt-0.5 leading-relaxed">{t('在会话、提问、工具调用的关键时刻自动跑你的命令（输入是 JSON，从 stdin 读）。共 {n} 条。', { n: total })}</div>
          </div>
          <button type="button" role="switch" aria-checked={enabled} aria-label={t('启用 Hooks')} data-testid="hooks-enabled"
            onClick={() => { setEnabled((v) => !v); touch(); }}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${enabled ? 'bg-gold/80' : 'bg-lift/15'}`}>
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        </div>
        {file && <div className="text-[11px] text-mute/70 font-mono break-all">{file}</div>}
        <div className="rounded-lg border border-edge/50 bg-well/50 px-3 py-2 text-[11px] text-mute/80 leading-relaxed">
          {t('安全提示：hook 是以你的身份在本机执行的命令，只写你看得懂的命令。stdout 输出 JSON 可以表态：{"decision":"deny","message":"原因"}；非 JSON 文本当作提示信息。')}
        </div>
      </Card>

      {events.map((ev) => {
        const info = EVENT_INFO[ev] || { desc: '', matcher: '' };
        const list = lists[ev] || [];
        return (
          <Card key={ev} className="p-5 space-y-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] text-ink font-medium font-mono">{ev}</div>
                <div className="text-[11px] text-mute mt-0.5">{t(info.desc)}</div>
              </div>
              <button type="button" onClick={() => addHook(ev)} className="btn-ghost shrink-0 rounded-md px-2.5 py-1 text-[11px] text-mute hover:text-ink">{t('添加')}</button>
            </div>
            {list.map((h, i) => {
              const tr = tests[`${ev}:${i}`];
              const r = tr?.result;
              return (
                <div key={i} className="rounded-lg border border-edge/50 bg-well/40 p-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <input value={h.matcher} onChange={(e) => update(ev, i, { matcher: e.target.value })} spellCheck={false}
                      placeholder={t('匹配（可空 = 全部）：{m}', { m: t(info.matcher) })} aria-label={t('匹配')}
                      className={`min-w-0 flex-1 rounded-md border bg-well px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-gold/50 ${badMatcher(h.matcher.trim()) ? 'border-red-500/60' : 'border-edge/70'}`} />
                    <input value={h.timeoutMs} onChange={(e) => update(ev, i, { timeoutMs: e.target.value.replace(/[^\d]/g, '') })}
                      placeholder={t('超时 ms')} aria-label={t('超时 ms')}
                      className="w-20 shrink-0 rounded-md border border-edge/70 bg-well px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-gold/50" />
                  </div>
                  <textarea value={h.command} onChange={(e) => update(ev, i, { command: e.target.value })} spellCheck={false} rows={2}
                    placeholder={t('命令，例如 node D:/hooks/check.mjs 或 npx prettier --write "$FILE"')} aria-label={t('命令')}
                    className="w-full rounded-md border border-edge/70 bg-well px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-gold/50 resize-y" />
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => runTest(ev, i)} disabled={!h.command.trim() || tr?.running}
                      className="btn-ghost rounded-md px-2.5 py-1 text-[11px] text-mute hover:text-ink">{tr?.running ? t('运行中…') : t('试跑')}</button>
                    <button type="button" onClick={() => removeHook(ev, i)} className="ml-auto rounded-md px-2 py-1 text-[11px] text-red-300/80 hover:bg-red-500/10">{t('删除')}</button>
                  </div>
                  {r && (
                    <div className="rounded-md bg-black/20 px-2.5 py-2 text-[11px] font-mono leading-relaxed space-y-1" data-testid="hook-test-result">
                      {r.error ? <div className="text-red-300">{r.error}</div> : (
                        <>
                          <div>
                            <span className={r.decision === 'deny' ? 'text-red-300' : r.decision === 'ask' ? 'text-amber-300' : 'text-jade'}>{t('判定：{d}', { d: r.decision })}</span>
                            <span className="text-mute/70">{'  ·  '}{t('退出码 {c}', { c: r.outputs?.[0]?.code ?? '-' })}{'  ·  '}{r.ms}ms</span>
                          </div>
                          {r.outputs?.[0]?.stdout ? <div className="text-ink/85 whitespace-pre-wrap break-all">stdout: {r.outputs[0].stdout.slice(0, 800)}</div> : null}
                          {r.outputs?.[0]?.stderr ? <div className="text-amber-200/80 whitespace-pre-wrap break-all">stderr: {r.outputs[0].stderr.slice(0, 800)}</div> : null}
                          {[...(r.messages || []), ...(r.errors || []), ...(r.warnings || [])].map((m, k) => <div key={k} className="text-mute">{m}</div>)}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        );
      })}

      <Card className="p-4 space-y-2">
        {warnings.length > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200/90 space-y-0.5">
            {warnings.map((w) => <div key={w}>{w}</div>)}
          </div>
        )}
        <ErrorNote>{error}</ErrorNote>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-primary" onClick={save} disabled={!y?.hooksSave || saving || !dirty || invalid}>
            {saving ? t('保存中…') : t('保存 Hooks')}
          </button>
          {invalid && <span className="text-[11px] text-red-300">{t('有匹配规则不是合法的正则')}</span>}
          {saved && !dirty && <span className="text-[11px] text-mute/70">{t('已保存，立即生效')}</span>}
        </div>
      </Card>
    </div>
  );
}
