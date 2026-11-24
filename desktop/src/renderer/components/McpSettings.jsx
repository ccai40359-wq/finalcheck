// 设置 → MCP 服务器（0.33.0）
// 配置就是 config.json 里的 mcpServers（和 Claude Code / Claude Desktop 同形，可以直接粘贴过来）。
// 上半部分：每个服务器的连接状态、工具清单、重启；下半部分：JSON 编辑器（保存即重连）。
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, Card, ErrorNote } from '../lib/ui.jsx';
import { t } from '../i18n/core.mjs';

const EXAMPLE = {
  filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/Projects'] },
  remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer <token>' }, disabled: true }
};

const STATE_STYLE = {
  ready: 'text-jade border-jade/30 bg-jade/[0.06]',
  connecting: 'text-goldSoft border-gold/30 bg-gold/[0.06]',
  error: 'text-red-300 border-red-500/35 bg-red-500/[0.07]',
  invalid: 'text-red-300 border-red-500/35 bg-red-500/[0.07]',
  disabled: 'text-mute border-edge/60 bg-well',
  closed: 'text-mute border-edge/60 bg-well',
  idle: 'text-mute border-edge/60 bg-well'
};
const STATE_LABEL = { ready: '已连接', connecting: '连接中…', error: '连接失败', invalid: '配置有误', disabled: '已停用', closed: '已关闭', idle: '未启动' };

export default function McpSettings() {
  const y = api();
  const [status, setStatus] = useState([]);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState([]);
  const [open, setOpen] = useState({});

  const refresh = useCallback(async () => {
    try { setStatus((await y?.mcpStatus?.()) || []); } catch { /* 主进程未就绪 */ }
  }, [y]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await y?.getConfig?.();
        if (alive) setText(JSON.stringify(cfg?.mcpServers || {}, null, 2));
      } catch { /* 忽略 */ }
      refresh();
    })();
    const off = y?.onMcpChanged?.(() => refresh());
    return () => { alive = false; off?.(); };
  }, [y, refresh]);

  const parsed = useMemo(() => {
    try {
      const v = JSON.parse(text || '{}');
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: t('必须是一个 JSON 对象：{ "名字": { "command": ... } }') };
      return { value: v };
    } catch (e) { return { error: t('JSON 格式错误：{msg}', { msg: e.message }) }; }
  }, [text]);

  const save = async () => {
    if (parsed.error) return;
    setSaving(true); setError(''); setWarnings([]);
    try {
      const r = await y?.mcpSave?.(parsed.value);
      if (!r?.ok) setError(r?.error || t('保存失败'));
      else { setDirty(false); setWarnings(r.warnings || []); setStatus(r.status || []); }
    } catch (e) { setError(String(e?.message || e)); }
    setSaving(false);
  };

  const restart = async (name) => {
    setStatus((s) => s.map((x) => (x.name === name ? { ...x, state: 'connecting', error: '' } : x)));
    try { setStatus((await y?.mcpRestart?.(name)) || []); } catch { refresh(); }
  };

  const total = status.reduce((n, s) => n + (s.tools?.length || 0), 0);

  return (
    <div className="space-y-4">
      <Card className="p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm text-ink font-medium">{t('已配置的服务器')}</div>
            <div className="text-xs text-mute mt-0.5">
              {status.length
                ? t('{n} 个服务器 · {tools} 个工具（AI 以 mcp__服务器__工具 的名字调用，默认每次调用都需要你批准）', { n: status.length, tools: total })
                : t('还没有配置 MCP 服务器。在下面的 JSON 里添加后保存即可连接。')}
            </div>
          </div>
          <button type="button" className="btn-ghost shrink-0 rounded-lg px-2.5 py-1 text-[11px] text-mute hover:text-ink" onClick={refresh}>{t('刷新')}</button>
        </div>
        {status.map((s) => (
          <div key={s.name} className="rounded-lg border border-edge/60 bg-well/60">
            <div className="flex items-center gap-2.5 px-3 py-2.5">
              <span className={`shrink-0 rounded-md border px-1.5 py-[1px] text-[10px] ${STATE_STYLE[s.state] || STATE_STYLE.idle}`}>{t(STATE_LABEL[s.state] || s.state)}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-ink font-mono truncate">{s.name}
                  {s.serverInfo?.name ? <span className="text-mute/70 font-sans text-[11px]"> · {s.serverInfo.name} {s.serverInfo.version || ''}</span> : null}
                </div>
                <div className="text-[11px] text-mute/70 font-mono truncate" title={s.target}>{[s.transport, s.target].filter(Boolean).join(' · ')}</div>
              </div>
              {s.tools?.length > 0 && (
                <button type="button" className="btn-ghost shrink-0 rounded-md px-2 py-0.5 text-[11px] text-mute hover:text-ink"
                  onClick={() => setOpen((o) => ({ ...o, [s.name]: !o[s.name] }))}>
                  {t('{n} 个工具', { n: s.tools.length })} {open[s.name] ? '▴' : '▾'}
                </button>
              )}
              {s.state !== 'disabled' && s.state !== 'invalid' && (
                <button type="button" className="btn-ghost shrink-0 rounded-md px-2 py-0.5 text-[11px] text-mute hover:text-ink" onClick={() => restart(s.name)} disabled={s.state === 'connecting'}>{t('重启')}</button>
              )}
            </div>
            {s.error && <div className="px-3 pb-2.5 -mt-1 text-[11px] text-red-300/90 leading-relaxed break-words">{s.error}</div>}
            {open[s.name] && (
              <div className="border-t border-edge/50 px-3 py-2 space-y-1 max-h-60 overflow-y-auto">
                {s.tools.map((tool) => (
                  <div key={tool.name} className="text-[11px] leading-relaxed">
                    <span className="font-mono text-goldSoft/90">{tool.name}</span>
                    {tool.description ? <span className="text-mute/80"> — {tool.description}</span> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </Card>

      <Card className="p-5 space-y-3">
        <div>
          <div className="text-sm text-ink font-medium">mcpServers（JSON）</div>
          <div className="text-xs text-mute mt-0.5 leading-relaxed">
            {t('和 Claude Code / Claude Desktop 的格式一样，可以直接粘贴。stdio 写 command / args / env；远程服务器写 type: "http" 和 url / headers。额外支持 disabled、timeoutMs、autoApprove（["工具名"] 或 true，跳过审批）。')}
          </div>
        </div>
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setDirty(true); }}
          spellCheck={false}
          aria-label={t('MCP 服务器配置')}
          className="w-full h-64 rounded-lg border border-edge/70 bg-well px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-gold/50 resize-y"
        />
        {parsed.error && <div className="text-[11px] text-red-300">{parsed.error}</div>}
        <div className="flex items-center gap-2">
          <button type="button" className="btn-primary" onClick={save} disabled={!y?.mcpSave || saving || !!parsed.error || !dirty}>
            {saving ? t('保存并连接中…') : t('保存并连接')}
          </button>
          <button type="button" className="btn-ghost rounded-lg px-3 py-1.5 text-xs text-mute hover:text-ink"
            onClick={() => { setText(JSON.stringify({ ...(parsed.value || {}), ...EXAMPLE }, null, 2)); setDirty(true); }}>
            {t('插入示例')}
          </button>
          {!dirty && !saving && status.length > 0 && <span className="text-[11px] text-mute/70">{t('已保存')}</span>}
        </div>
        {warnings.length > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200/90 space-y-0.5">
            {warnings.map((w) => <div key={w}>{w}</div>)}
          </div>
        )}
        <ErrorNote>{error}</ErrorNote>
        <div className="rounded-lg border border-edge/50 bg-well/50 px-3 py-2 text-[11px] text-mute/80 leading-relaxed">
          {t('安全提示：MCP 服务器是第三方程序，以你的身份在本机运行，能访问它被配置的一切。只添加你信任的服务器；它返回的内容 AI 只当作数据，不会当作指令执行。')}
        </div>
      </Card>
    </div>
  );
}
