"""README / GitHub 视觉资产生成器（0.32.9，石墨琥珀）。

一次生成：hero（README 顶图）、diagram-en / diagram-zh（为什么选终检）、social-preview（仓库分享卡）。
源是本文件里的 SVG 模板；PNG / WebP 由**一次性配置目录**的无头 Edge 光栅化（不碰用户浏览器配置）。

用法（仓库根目录）：
    python docs/assets/src/make_assets.py
输出：docs/assets/*.svg（矢量源）+ *.png / hero.webp（README 实际引用的位图）

为什么 README 引用位图而不是 SVG：GitHub 通过 camo 代理图片，SVG 里的字体取决于看图人的系统，
中文在 macOS / Linux 上会回落成别的字体，排版会跑；位图在这里一次渲好，所有人看到的一样。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
from html import escape

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.dirname(HERE)
EDGE_CANDIDATES = [
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
]

# ---- 设计令牌（与桌面端深色主题同源：styles.css :root） ----
BG = '#131316'
BG_TOP = '#19191d'
PANEL = '#18181c'
CARD = '#1e1e23'
LINE = '#2c2c33'
LINE_SOFT = '#24242a'
INK = '#ecebe8'
INK2 = '#c9c8cc'
MUTE = '#8f8e96'
FAINT = '#62616a'
AMBER = '#d9a95c'
AMBER_SOFT = '#ecc78e'
GREEN = '#5cb88a'
ORANGE = '#e0894f'
RED = '#e36464'
SANS = "'Segoe UI Variable Display','Segoe UI','Microsoft YaHei UI','Microsoft YaHei','PingFang SC',sans-serif"
MONO = "'Cascadia Mono','Cascadia Code',Consolas,monospace"

LOGO_PATHS = [
    'M140 362 V196 q0 -44 44 -44 H226',
    'M140 258 H208',
    'M392 200 A88 88 0 1 0 374 338',
    'M356 272 L384 300 L436 240',
]


def logo(x: float, y: float, size: float, uid: str) -> str:
    """完整标识：石墨底牌 + 琥珀 FC✓（与 desktop/build/brand/logo.svg 同一组路径）。"""
    k = size / 512
    paths = ''.join(f'<path d="{d}"/>' for d in LOGO_PATHS)
    return f'''
  <g transform="translate({x} {y}) scale({k})">
    <defs>
      <linearGradient id="{uid}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2a30"/><stop offset="1" stop-color="#151518"/></linearGradient>
      <linearGradient id="{uid}au" gradientUnits="userSpaceOnUse" x1="130" y1="130" x2="440" y2="390">
        <stop offset="0" stop-color="#f0d29c"/><stop offset="0.55" stop-color="#d9a95c"/><stop offset="1" stop-color="#b8843e"/></linearGradient>
    </defs>
    <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#{uid}bg)"/>
    <rect x="17.5" y="17.5" width="477" height="477" rx="110.5" fill="none" stroke="#fff" stroke-opacity="0.1" stroke-width="4"/>
    <g fill="none" stroke="url(#{uid}au)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round" transform="translate(-14 0)">{paths}</g>
  </g>'''


def text_w(s: str, size: float) -> float:
    """粗估文字宽度（排胶囊用）：CJK 按 1em，拉丁按 0.56em。"""
    w = 0.0
    for ch in s:
        w += size if ord(ch) > 0x2E80 else size * 0.56
    return w


def t(x, y, s, size=13, fill=INK, weight=400, anchor='start', family=SANS, extra=''):
    return (f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill}" text-anchor="{anchor}" {extra}>{escape(s)}</text>')


def svg_open(w, h, label):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{escape(label)}">\n'
            f'  <defs><linearGradient id="pagebg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{BG_TOP}"/><stop offset="1" stop-color="{BG}"/></linearGradient>\n'
            f'  <radialGradient id="warm" cx="0.12" cy="0" r="0.7"><stop offset="0" stop-color="{AMBER}" stop-opacity="0.07"/><stop offset="1" stop-color="{AMBER}" stop-opacity="0"/></radialGradient></defs>\n'
            f'  <rect width="{w}" height="{h}" fill="url(#pagebg)"/>\n  <rect width="{w}" height="{h}" fill="url(#warm)"/>\n')


# ------------------------------------------------------------------ diagram

DIAGRAM = {
    'en': dict(
        label='Why FinalCheck: tiered delivery acceptance',
        title='Why FinalCheck', tag='Tiered delivery acceptance — not another scanner',
        inp=('Your code', 'AI-written or downloaded', '11 dimensions to check', 'Desktop app · runs locally'),
        gate='DELIVERY GATE · THREE TIERS',
        tiers=[('L1', 'Personal', 'S3 secrets block; the rest is advisory', AMBER),
               ('L2', 'With users', 'High blocks; medium must be fixed', ORANGE),
               ('L3', 'Company', 'Nothing ships until the matrix passes', RED)],
        out='OUTPUT · ONE VERDICT',
        verdicts=[('Pass', "within this run's scope", GREEN), ('Fix, then pass', 'open items to confirm', AMBER),
                  ('Block', 'confirmed high / gate failed', RED), ('Cannot accept', 'checks not run', MUTE)],
        dims_label='11 DIMENSIONS · ONE MATRIX TO PASS',
        dims=['Security', 'Privacy', 'Supply chain & licenses', 'Maintainability', 'Readability', 'Testability',
              'Robustness', 'Stability', 'Performance', 'Observability', 'Handover'],
        cards=[('Every claim is checkable', ['Not "a possible risk" — a file and a line.', 'A second agent argues against it;', 'unconfirmed is never a pass.'], 'rule · file:line · fingerprint · verdict'),
               ('Unknown is not a pass', ['Checks that did not run and targets that', 'could not be reached are recorded as gaps,', 'never counted as passed.'], 'coverage gap · cannot accept · fail-closed'),
               ('Local by design', ['Engine and reports stay on your machine;', 'keys never leave it. Commands run inside', 'write / delete bounds.'], 'local-first · restricted token · Apache-2.0')],
        foot='Apache-2.0 · Windows desktop + CLI · English & 中文',
    ),
    'zh': dict(
        label='为什么选终检：分级交付验收',
        title='为什么选终检', tag='分级交付验收 · 不是扫一遍告警',
        inp=('代码进来', 'AI 写的 / 下载的项目', '11 个维度待验', '桌面端 · 本地运行'),
        gate='交付闸 · 三档',
        tiers=[('L1', '自用', 'S3 密钥硬卡，其余提醒', AMBER),
               ('L2', '有用户', '高危拦截，中危必修', ORANGE),
               ('L3', '公司级', '未达标不放行，出可出示的验收报告', RED)],
        out='输出 · 一个判定',
        verdicts=[('过', '本轮范围内通过', GREEN), ('修完再过', '有待确认项', AMBER),
                  ('拦', '高危实锤 / 卡项未过', RED), ('无法验收', '应跑未跑 / 有缺口', MUTE)],
        dims_label='11 个维度 · 一张矩阵过关',
        dims=['安全', '隐私', '供应链与许可', '可维护', '可读', '可测', '鲁棒', '稳定', '性能', '可观测', '可移交'],
        cards=[('每条结论可复核', ['不是「可能有风险」，而是文件 + 行号。', '另一路 agent 专门反驳，', '不确认不算过。'], 'rule · file:line · fingerprint · verdict'),
               ('不知道 ≠ 通过', ['证据缺口单独记账：没跑的检查、', '抓不到的目标，', '一律不许冒充通过。'], 'coverage gap · 无法验收 · fail-closed'),
               ('本地跑，不外传', ['引擎与报告都在你机器上，Key 只存本机。', '命令执行有写 / 删边界，', '越界直接拒绝。'], 'local-first · restricted token · Apache-2.0')],
        foot='Apache-2.0 · Windows 桌面端 + CLI · 中英双语',
    ),
}


def section_label(x, y, s):
    return t(x, y, s, size=10.5, fill=MUTE, weight=600, extra='letter-spacing="1.2"')


def arrow(x1, x2, y):
    return (f'<line x1="{x1}" y1="{y}" x2="{x2 - 2}" y2="{y}" stroke="{FAINT}" stroke-width="1.5"/>'
            f'<path d="M{x2 - 8} {y - 5} L{x2} {y} L{x2 - 8} {y + 5}" fill="none" stroke="{FAINT}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>')


def diagram(lang: str) -> str:
    d = DIAGRAM[lang]
    W, H = 1200, 660
    o = [svg_open(W, H, d['label'])]
    o.append(logo(60, 30, 34, 'lg'))
    o.append(t(106, 54, d['title'], size=22, weight=700))
    o.append(t(W - 60, 52, d['tag'], size=12, fill=MUTE, anchor='end'))

    # A：输入
    o.append(f'<rect x="60" y="112" width="226" height="132" rx="12" fill="{CARD}" stroke="{LINE}"/>')
    o.append(t(80, 146, d['inp'][0], size=15, weight=600))
    o.append(t(80, 172, d['inp'][1], size=12, fill=INK2))
    o.append(t(80, 194, d['inp'][2], size=11, fill=MUTE))
    o.append(f'<line x1="80" y1="210" x2="266" y2="210" stroke="{LINE_SOFT}"/>')
    o.append(t(80, 230, d['inp'][3], size=11, fill=FAINT))
    o.append(arrow(296, 382, 178))

    # B：交付闸三档
    o.append(f'<rect x="390" y="92" width="420" height="204" rx="14" fill="{PANEL}" stroke="{LINE_SOFT}"/>')
    o.append(section_label(408, 116, d['gate']))
    for i, (lv, name, desc, color) in enumerate(d['tiers']):
        y = 128 + i * 54
        o.append(f'<rect x="404" y="{y}" width="392" height="46" rx="9" fill="{CARD}" stroke="{LINE}"/>')
        o.append(f'<rect x="404" y="{y + 10}" width="3" height="26" rx="1.5" fill="{color}"/>')
        o.append(t(420, y + 20, lv, size=11, fill=color, weight=700, family=MONO))
        o.append(t(446, y + 20, name, size=13, weight=600))
        o.append(t(420, y + 37, desc, size=11, fill=MUTE))
    o.append(arrow(818, 854, 178))

    # C：判定
    o.append(f'<rect x="862" y="92" width="278" height="204" rx="14" fill="{PANEL}" stroke="{LINE_SOFT}"/>')
    o.append(section_label(880, 116, d['out']))
    for i, (name, desc, color) in enumerate(d['verdicts']):
        y = 128 + i * 40
        o.append(f'<rect x="876" y="{y}" width="250" height="32" rx="16" fill="{CARD}" stroke="{LINE}"/>')
        o.append(f'<circle cx="893" cy="{y + 16}" r="4" fill="{color}"/>')
        o.append(t(905, y + 20.5, name, size=12.5, weight=600))
        o.append(t(1114, y + 20, desc, size=10.5, fill=MUTE, anchor='end'))

    # 11 维度
    o.append(f'<rect x="60" y="318" width="1080" height="88" rx="14" fill="{PANEL}" stroke="{LINE_SOFT}"/>')
    o.append(section_label(78, 342, d['dims_label']))
    # 放不下就整体缩字号（不压胶囊宽度——压宽度会让圆点贴到字上）
    gap, fs = 7, 11.5
    while True:
        pad = fs * 1.05
        widths = [text_w(s, fs) * 1.06 + pad * 2 + 8 for s in d['dims']]
        total = sum(widths) + gap * (len(widths) - 1)
        if total <= 1048 or fs <= 9:
            break
        fs -= 0.25
    x = 60 + (1080 - total) / 2
    for s, w in zip(d['dims'], widths):
        o.append(f'<rect x="{x:.1f}" y="356" width="{w:.1f}" height="32" rx="16" fill="{CARD}" stroke="{LINE}"/>')
        o.append(f'<circle cx="{x + pad:.1f}" cy="372" r="2.5" fill="{AMBER}"/>')
        o.append(t(f'{x + pad + 8:.1f}', 376, s, size=fs, fill=INK2))
        x += w + gap

    # 三张差异卡
    for i, (title, lines, tags) in enumerate(d['cards']):
        x = 60 + i * 370
        o.append(f'<rect x="{x}" y="430" width="340" height="164" rx="14" fill="{CARD}" stroke="{LINE}"/>')
        o.append(f'<circle cx="{x + 32}" cy="464" r="12" fill="none" stroke="{AMBER}" stroke-opacity="0.7"/>')
        o.append(t(x + 32, 468.5, str(i + 1), size=12, fill=AMBER_SOFT, weight=700, anchor='middle'))
        o.append(t(x + 54, 469, title, size=15, weight=600))
        for j, line in enumerate(lines):
            o.append(t(x + 22, 502 + j * 20, line, size=12, fill=INK2))
        o.append(f'<line x1="{x + 22}" y1="562" x2="{x + 318}" y2="562" stroke="{LINE_SOFT}"/>')
        o.append(t(x + 22, 581, tags, size=10.5, fill=FAINT, family=MONO))

    o.append(t(60, 632, d['foot'], size=11, fill=FAINT))
    o.append(t(W - 60, 632, 'github.com/ccai40359-wq/finalcheck', size=11, fill=FAINT, anchor='end'))
    o.append('</svg>\n')
    return '\n'.join(o)


# ------------------------------------------------------------------ hero / social

def report_card(x, y, w, uid):
    """右侧的「验收单」示意：几行维度 + 状态，底部一个判定。"""
    rows = [('Security', 'pass', GREEN), ('Privacy', 'pass', GREEN), ('Supply chain', 'fix', AMBER),
            ('Robustness', 'pass', GREEN), ('Handover', 'gap', MUTE)]
    h = 56 + len(rows) * 34 + 58
    o = [f'<g filter="url(#{uid}sh)">',
         f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="{CARD}" stroke="{LINE}"/></g>',
         f'<circle cx="{x + 22}" cy="{y + 24}" r="4" fill="#3a3a42"/><circle cx="{x + 36}" cy="{y + 24}" r="4" fill="#3a3a42"/><circle cx="{x + 50}" cy="{y + 24}" r="4" fill="#3a3a42"/>',
         t(x + w - 22, y + 28, 'L2 · acceptance', size=11, fill=MUTE, anchor='end', family=MONO),
         f'<line x1="{x}" y1="{y + 44}" x2="{x + w}" y2="{y + 44}" stroke="{LINE_SOFT}"/>']
    for i, (name, st, color) in enumerate(rows):
        ry = y + 56 + i * 34
        o.append(t(x + 22, ry + 16, name, size=13, fill=INK2))
        o.append(f'<line x1="{x + 140}" y1="{ry + 12}" x2="{x + w - 92}" y2="{ry + 12}" stroke="{LINE_SOFT}" stroke-dasharray="2 4"/>')
        o.append(f'<rect x="{x + w - 82}" y="{ry}" width="60" height="22" rx="11" fill="{color}" fill-opacity="0.14"/>')
        o.append(t(x + w - 52, ry + 15, st, size=11, fill=color, weight=600, anchor='middle', family=MONO))
    vy = y + 56 + len(rows) * 34 + 8
    o.append(f'<rect x="{x + 16}" y="{vy}" width="{w - 32}" height="38" rx="10" fill="{AMBER}" fill-opacity="0.10" stroke="{AMBER}" stroke-opacity="0.35"/>')
    o.append(f'<path d="M{x + 32} {vy + 19} l5 5 l10 -11" fill="none" stroke="{AMBER_SOFT}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>')
    o.append(t(x + 56, vy + 24, 'Fix, then pass', size=13, fill=AMBER_SOFT, weight=600))
    o.append(t(x + w - 30, vy + 24, '1 open item', size=11, fill=MUTE, anchor='end'))
    return '\n'.join(o), h


def hero() -> str:
    W, H = 1600, 400
    o = [svg_open(W, H, 'FinalCheck — pre-flight check for AI-written code')]
    o.append(f'<defs><filter id="hsh" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.45"/></filter>'
             f'<pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#fff" stroke-opacity="0.025"/></pattern>'
             f'<linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0.45" stop-color="{BG}" stop-opacity="1"/><stop offset="1" stop-color="{BG}" stop-opacity="0"/></linearGradient></defs>')
    o.append(f'<rect width="{W}" height="{H}" fill="url(#grid)"/>')
    o.append(f'<rect width="{W}" height="{H}" fill="url(#fade)"/>')
    # README 里这张图会被缩到约 0.55 倍显示，所以字号按「缩完还读得清」来定
    o.append(logo(132, 112, 92, 'h'))
    o.append(t(248, 184, 'Final', size=76, weight=700, extra='letter-spacing="-1.5"')
             .replace('</text>', f'<tspan fill="{MUTE}">Check</tspan></text>'))
    o.append(t(248 + 392, 184, '终检', size=46, fill=AMBER_SOFT))
    o.append(t(136, 262, 'Pre-flight check for AI-written code.', size=30, fill=INK2, weight=500))
    o.append(t(136, 304, '11 dimensions · file:line evidence · one verdict', size=22, fill=MUTE))
    card, _ = report_card(1040, 72, 400, 'h')
    o.append(card)
    o.append('</svg>\n')
    return '\n'.join(o)


def social() -> str:
    W, H = 1280, 640
    o = [svg_open(W, H, 'FinalCheck')]
    o.append(f'<defs><filter id="ssh" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.45"/></filter>'
             f'<pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#fff" stroke-opacity="0.025"/></pattern></defs>')
    o.append(f'<rect width="{W}" height="{H}" fill="url(#grid)"/>')
    o.append(logo(96, 170, 96, 's'))
    o.append(t(96, 340, 'Final', size=72, weight=700, extra='letter-spacing="-1"')
             .replace('</text>', f'<tspan fill="{MUTE}">Check</tspan></text>'))
    o.append(t(96 + 372, 340, '终检', size=44, fill=AMBER_SOFT))
    o.append(t(98, 392, 'Pre-flight check for AI-written code.', size=24, fill=INK2))
    o.append(t(98, 428, '11 dimensions · file:line evidence · one verdict', size=18, fill=MUTE))
    o.append(t(98, 560, 'github.com/ccai40359-wq/finalcheck', size=16, fill=FAINT, family=MONO))
    card, _ = report_card(800, 136, 380, 's')
    o.append(card)
    o.append('</svg>\n')
    return '\n'.join(o)


# ------------------------------------------------------------------ 光栅化

def edge() -> str:
    for p in EDGE_CANDIDATES:
        if os.path.exists(p):
            return p
    raise SystemExit('没找到 Edge / Chrome，无法光栅化（SVG 已生成）')


def rasterize(svg_path: str, png_path: str, w: int, h: int, scale: int) -> None:
    profile = tempfile.mkdtemp(prefix='fc-assets-')
    try:
        subprocess.run([edge(), '--headless=new', '--disable-gpu', '--hide-scrollbars',
                        f'--user-data-dir={profile}', '--default-background-color=00000000',
                        f'--force-device-scale-factor={scale}', f'--window-size={w},{h}',
                        f'--screenshot={png_path}', 'file:///' + svg_path.replace('\\', '/')],
                       check=False, capture_output=True, timeout=60)
        # Windows 上 msedge 启动器会把活交给脱离的子进程后立刻返回——轮询等截图落盘且大小稳定
        last = -1
        for _ in range(120):
            if os.path.exists(png_path):
                size = os.path.getsize(png_path)
                if size > 0 and size == last:
                    break
                last = size
            time.sleep(0.25)
    finally:
        time.sleep(0.5)
        shutil.rmtree(profile, ignore_errors=True)
    if not os.path.exists(png_path):
        raise SystemExit(f'rasterize failed: {png_path}')


def main() -> None:
    jobs = [('hero', hero(), 1600, 400, 1), ('social-preview', social(), 1280, 640, 1),
            ('diagram-en', diagram('en'), 1200, 660, 2), ('diagram-zh', diagram('zh'), 1200, 660, 2)]
    for name, svg, w, h, scale in jobs:
        svg_path = os.path.join(ASSETS, f'{name}.svg')
        png_path = os.path.join(ASSETS, f'{name}.png')
        with open(svg_path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(svg)
        if os.path.exists(png_path):
            os.remove(png_path)
        rasterize(svg_path, png_path, w, h, scale)
        im = Image.open(png_path).convert('RGB')
        im.save(png_path, optimize=True)
        if name == 'hero':
            im.save(os.path.join(ASSETS, 'hero.webp'), quality=92, method=6)
        print(f'{name}: {im.size}')


if __name__ == '__main__':
    main()
