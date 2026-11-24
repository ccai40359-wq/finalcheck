// 设置 → 权限规则（0.33.0，对齐 Claude Code 的 permissions.allow / deny）
// 两个编辑框，一行一条规则；下面一个「试一下」用还没保存的规则判定假想的调用，改规则前就能看到效果。
import React, { useEffect, useState } from 'react';
import { api, Card, ErrorNote } from '../lib/ui.jsx';
import { t } from '../i18n/core.mjs';

const TEST_TOOLS = ['run_command', 'edit_file', 'write_file', 'read_file', 'browser_navigate'];
const EXAMPLE_ALLOW = ['run_command(npm test*)', 'run_command(git status)', 'run_command(git diff:*)', 'edit_file(src/**)'];
const EXAMPLE_DENY = ['run_command(git push*)', 'run_command(rm -rf*)', 'read_file(**/.env)', 'edit_file(**/.env)'];

const toLines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

function RuleBox({ label, hint, value, onChange, tone }) {
  const count = toLines(value).length;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <div className={`text-[13px] font-medium ${tone}`}>{label}</div>
        <div className="text-[11px] text-mute/70">{t('{n} 条', { n: count })}</div>
      </div>
      <div className="text-[11px] text-mute leading-relaxed">{hint}</div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        aria-label={label}
        placeholder={t('一行一条，例如 run_command(npm test*)')}
        className="w-full h-32 rounded-lg border border-edge/70 bg-well px-3 py-2 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-gold/50 resize-y"
      />
    </div>
  );
}

export default function PermissionRules() {
  const y = api();
  const [allow, setAllow] = useState('');
  const [deny, setDeny] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [testTool, setTestTool] = useState('run_command');
  const [testInput, setTestInput] = useState('');
  const [verdict, setVerdict] = useState(null);

  useEffect(() => {
    let alive = true;
    y?.permissionRulesGet?.().then((r) => {
      if (!alive || !r) return;
      setAllow((r.allow || []).join('\n'));
      setDeny((r.deny || []).join('\n'));
    }).catch(() => {});
    return () => { alive = false; };
  }, [y]);

  // 试一下：规则或输入变了就重新判定（用编辑框里的草稿，不用已保存的）
  useEffect(() => {
    if (!testInput.trim() || !y?.permissionRulesTest) { setVerdict(null); return undefined; }
    let alive = true;
    const h = setTimeout(() => {
      y.permissionRulesTest({ rules: { allow: toLines(allow), deny: toLines(deny) }, tool: testTool, input: testInput })
        .then((r) => { if (alive) setVerdict(r); }).catch(() => {});
    }, 150);
    return () => { alive = false; clearTimeout(h); };
  }, [y, allow, deny, testTool, testInput]);

  const edit = (setter) => (v) => { setter(v); setDirty(true); setSaved(false); setErrors([]); };

  const save = async () => {
    setSaving(true); setError(''); setErrors([]);
    try {
      const r = await y?.permissionRulesSave?.({ allow: toLines(allow), deny: toLines(deny) });
      if (!r?.ok) setErrors(r?.errors || [t('保存失败')]);
      else { setDirty(false); setSaved(true); }
    } catch (e) { setError(String(e?.message || e)); }
    setSaving(false);
  };

  const addExamples = () => {
    const merge = (cur, ex) => [...new Set([...toLines(cur), ...ex])].join('\n');
    setAllow((v) => merge(v, EXAMPLE_ALLOW));
    setDeny((v) => merge(v, EXAMPLE_DENY));
    setDirty(true); setSaved(false);
  };

  const v = verdict?.decision;
  const verdictView = !testInput.trim() ? null
    : v === 'deny' ? { cls: 'text-red-300 border-red-500/35 bg-red-500/[0.07]', text: t('拒绝'), note: t('命中 {rule}', { rule: verdict.rule }) }
      : v === 'allow' ? { cls: 'text-jade border-jade/30 bg-jade/[0.06]', text: t('直接允许'), note: t('命中 {rule}', { rule: verdict.rule }) }
        : { cls: 'text-mute border-edge/60 bg-well', text: t('按权限模式处理'), note: t('没有命中规则：询问模式会弹审批，完全权限模式直接执行') };

  return (
    <div className="space-y-4">
      <Card className="p-5 space-y-4">
        <RuleBox
          label={t('拒绝（deny）')}
          tone="text-red-300"
          hint={t('命中就不执行，完全权限模式下也一样。优先级最高。')}
          value={deny}
          onChange={edit(setDeny)}
        />
        <RuleBox
          label={t('允许（allow）')}
          tone="text-jade"
          hint={t('命中就不再弹审批，跨会话、重启后都有效。复合命令（&& | ; 等）要每一段都命中才放行。定时唤醒等无人值守的回合不使用允许规则。')}
          value={allow}
          onChange={edit(setAllow)}
        />
        {errors.length > 0 && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300 space-y-0.5">
            {errors.map((e) => <div key={e}>{e}</div>)}
          </div>
        )}
        <ErrorNote>{error}</ErrorNote>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-primary" onClick={save} disabled={!y?.permissionRulesSave || saving || !dirty}>
            {saving ? t('保存中…') : t('保存规则')}
          </button>
          <button type="button" className="btn-ghost rounded-lg px-3 py-1.5 text-xs text-mute hover:text-ink" onClick={addExamples}>
            {t('插入常用示例')}
          </button>
          {saved && !dirty && <span className="text-[11px] text-mute/70">{t('已保存，下一条消息起生效')}</span>}
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <div>
          <div className="text-sm text-ink font-medium">{t('试一下')}</div>
          <div className="text-xs text-mute mt-0.5">{t('用上面还没保存的规则，看看一次调用会被怎样处理。')}</div>
        </div>
        <div className="flex items-center gap-2">
          <select value={testTool} onChange={(e) => setTestTool(e.target.value)} aria-label={t('工具')}
            className="shrink-0 rounded-lg border border-edge/70 bg-well px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-gold/50">
            {TEST_TOOLS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <input value={testInput} onChange={(e) => setTestInput(e.target.value)} spellCheck={false}
            aria-label={t('命令 / 路径 / 网址')}
            placeholder={testTool === 'run_command' ? 'git status && npm test' : testTool === 'browser_navigate' ? 'https://example.com/' : 'src/app.js'}
            className="min-w-0 flex-1 rounded-lg border border-edge/70 bg-well px-3 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-gold/50" />
        </div>
        {verdictView && (
          <div className="flex items-center gap-2 text-[12px]">
            <span className={`shrink-0 rounded-md border px-2 py-[1px] text-[11px] ${verdictView.cls}`}>{verdictView.text}</span>
            <span className="min-w-0 truncate text-mute font-mono text-[11px]" title={verdictView.note}>{verdictView.note}</span>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <div className="text-sm text-ink font-medium mb-2">{t('写法')}</div>
        <div className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5 text-[11px] leading-relaxed">
          {[
            ['run_command', t('整个工具')],
            ['run_command(npm test*)', t('* 匹配任意字符（命令里可以跨空格）')],
            ['run_command(git diff:*)', t('Claude Code 的前缀写法，等同 git diff*')],
            ['edit_file(src/**)', t('路径相对项目根，也可以写绝对路径；** 跨目录，* 不跨目录')],
            ['read_file(**/.env)', t('任意位置的 .env；拒绝规则对只读工具同样生效')],
            ['browser_navigate(https://*.bank.com/*)', t('网址同样用 * 通配')],
            ['mcp__github__*', t('工具名也能通配，常用于 MCP 工具')]
          ].map(([code, desc]) => (
            <React.Fragment key={code}>
              <code className="font-mono text-goldSoft/90">{code}</code>
              <span className="text-mute">{desc}</span>
            </React.Fragment>
          ))}
        </div>
      </Card>
    </div>
  );
}
