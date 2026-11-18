// run_command 的「读文件 / 搜代码」改道（2026-11-18）。
//
// 工具描述里一直写着「读文件必须用 read_file、搜代码必须用 grep_code，违反会被应用层拒绝」，
// 但应用层其实从没拦过——真实模型 E2E（6 个仓库）里 run_command 116 次，其中 `nl -ba` 读文件 37 次、
// `grep -rn` 搜代码 34 次、cat/tail 15 次。代价：shell 输出没有稳定的行号分页、超长被截断、
// 不进证据账本，结论里的 file:line 也就没法复核。
//
// 这里只拦「目的就是看源码内容」的写法；正当用途一律放行：
//   - 管道加工（cat a.json | jq、git log | grep、ls | grep）、写文件（cat > x <<EOF）、tail -f
//   - 日志 / 临时输出 / 工具结果落盘文件（*.log、/tmp/、spill/）——它们本来就该用 shell 看尾巴/检索
//   - 统计类（wc、grep -c、grep -l 只列文件名）

const READERS = /^(?:cat|nl|head|tail|less|more|bat|type)$/;
const SEARCHERS = /^(?:grep|egrep|fgrep|rg|ag|ack|findstr)$/;
// 读完还原样输出的「看内容」后续管道；接 jq/python/sort/node 等是加工，放行
const VIEW_PIPES = /^(?:head|tail|nl|sed|cat|less|more|cut|grep|egrep|rg)$/;
// 按命令段判断（不是整条）：`2>/dev/null` 到处都是，整条匹配会把同一行里的读源码一起放过（E2E 回放实测）
const EXEMPT_PATH = /(?:\.log|\.out|\.err)\b|(?:^|[\s"'])\/tmp\/|[\\/]spill[\\/]|\.finalcheck[\\/]ledger/i;
const stripQuoted = (s) => String(s).replace(/"[^"]*"|'[^']*'/g, '""');

// 按「引号外」的分隔符切：grep 模式里的 `\|`、`"a|b"` 不能当成管道/逻辑或（E2E 回放实测漏拦）
function splitUnquoted(text, kind) {
  const out = [];
  let cur = '';
  let q = null;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q && s[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (kind === 'seg') {
      if ((c === '&' && s[i + 1] === '&') || (c === '|' && s[i + 1] === '|')) { out.push(cur); cur = ''; i++; continue; }
      if (c === ';' || c === '\n') { out.push(cur); cur = ''; continue; }
    } else if (c === '|' && s[i + 1] !== '|' && s[i - 1] !== '\\') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function tokens(s) {
  return (String(s).match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
}

function classifyStage(stage) {
  const tk = tokens(stage);
  const prog = (tk[0] || '').replace(/^.*[\\/]/, '').toLowerCase();
  const args = tk.slice(1);
  const operands = args.filter((a) => !a.startsWith('-'));
  // 有重定向：在写文件/喂输入，不是看源码（先去掉引号里的内容：`grep "<artifactId>" pom.xml` 的 < 不是重定向）
  if (/[<>]/.test(stripQuoted(stage).replace(/2>\s*\/dev\/null|2>&1|>\s*\/dev\/null/g, ''))) return null;
  if (READERS.test(prog)) {
    if (prog === 'tail' && args.some((a) => /^-[a-zA-Z]*f/.test(a) || a === '--follow')) return null;
    if (!operands.length) return null; // 从管道读
    if (operands.every((o) => /^\d+$/.test(o))) return null; // head -n 20（从管道读）
    return { kind: 'read', prog };
  }
  if (prog === 'sed' && args[0] === '-n' && /^\d+(?:,\d+)?p$/.test(args[1] || '') && operands.length >= 2) return { kind: 'read', prog: 'sed -n' };
  if (prog === 'awk' && /^NR\s*[<>=!]/.test(args[0] || '') && operands.length >= 2) return { kind: 'read', prog: 'awk NR' };
  if (SEARCHERS.test(prog)) {
    if (args.some((a) => /^-[a-zA-Z]*[clL]/.test(a) || a === '--count' || a === '--files-with-matches')) return null; // 计数/只列文件名
    const paths = operands.slice(1); // 第一个非选项是 pattern
    const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a)) || prog === 'rg' || prog === 'ag' || prog === 'ack';
    if (!paths.length && !recursive) return null; // 从管道读
    return { kind: 'search', prog };
  }
  return null;
}

/**
 * 判断命令是不是在用 shell 读源码 / 搜代码。是 → 返回改道说明；否 → null。
 * @param {string} cmd
 * @returns {null | {kind:'read'|'search', segment:string, message:string}}
 */
export function shellReadRedirect(cmd) {
  const text = String(cmd || '');
  if (!text.trim()) return null;
  for (const seg of splitUnquoted(text, 'seg')) {
    const s = seg.trim();
    // `cd .../spill && grep …`：先进到工具结果落盘目录再检索，正是系统提示要求的用法，后续段一律放行
    if (/^cd\b/.test(s) && EXEMPT_PATH.test(s + '/')) return null;
    if (!s || /^(?:cd|echo|printf|pwd|export|set)\b/.test(s) || EXEMPT_PATH.test(s)) continue;
    const stages = splitUnquoted(s, 'pipe');
    const first = classifyStage(stages[0]);
    if (!first) continue;
    // 后面接的是加工程序（jq / python / sort / wc …）→ 不是在「看」内容
    const rest = stages.slice(1).map((x) => (tokens(x)[0] || '').replace(/^.*[\\/]/, '').toLowerCase());
    if (rest.length && !rest.every((p) => VIEW_PIPES.test(p))) continue;
    const message = first.kind === 'read'
      ? `这条命令是在用 shell 读源码（${first.prog}）：请改用 read_file(path, offset, limit)——自带行号、可分页、进证据账本，结论里的 file:line 才能复核。只读一段就传 offset/limit；多个文件就并行调用多次 read_file。命中的片段：\`${s.slice(0, 120)}\``
      : `这条命令是在用 shell 搜代码（${first.prog}）：请改用 grep_code(pattern, path)——直接返回 file:line:内容，结果不截断、进证据账本。只想统计数量/列文件名可以继续用 grep -c / grep -l。命中的片段：\`${s.slice(0, 120)}\``;
    return { kind: first.kind, segment: s, message };
  }
  return null;
}
