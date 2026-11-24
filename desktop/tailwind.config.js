/** @type {import('tailwindcss').Config} */
// 调色板全部指向 CSS 变量（styles.css 的 :root / [data-theme="light"]）。
// <alpha-value> 占位符让 Tailwind 的透明度修饰符照常可用：bg-gold/10 → rgb(var(--fc-gold) / 0.1)。
// 这样切主题只改 <html data-theme> 上的变量值，全部界面自动跟随，不用写两套类名。
export default {
  content: ['./src/renderer/**/*.{html,js,jsx}'],
  theme: {
    extend: {
      colors: {
        base: 'rgb(var(--fc-base) / <alpha-value>)',           // 页面底
        card: 'rgb(var(--fc-card) / <alpha-value>)',
        cardHover: 'rgb(var(--fc-card-hover) / <alpha-value>)',
        edge: 'rgb(var(--fc-edge) / <alpha-value>)',           // 分隔线/边框
        ink: 'rgb(var(--fc-ink) / <alpha-value>)',             // 正文墨
        mute: 'rgb(var(--fc-mute) / <alpha-value>)',           // 次要文字
        gold: 'rgb(var(--fc-gold) / <alpha-value>)',           // 鎏金主色
        goldSoft: 'rgb(var(--fc-gold-soft) / <alpha-value>)',
        goldDeep: 'rgb(var(--fc-gold-deep) / <alpha-value>)',
        jade: 'rgb(var(--fc-jade) / <alpha-value>)',           // 通过绿（语义色）
        // 叠加层色调：深色下是白（提亮），浅色下是黑（压暗）。
        // 原来写死成 bg-white/[0.06] 的玻璃高光一律换成 bg-lift/[0.06]，
        // 否则浅色主题下白叠白等于没效果。
        lift: 'rgb(var(--fc-lift) / <alpha-value>)',
        // 层次面
        sunken: 'rgb(var(--fc-sunken) / <alpha-value>)',       // 代码块底色
        panel: 'rgb(var(--fc-panel) / <alpha-value>)',         // 侧栏 / 右侧预览
        well: 'rgb(var(--fc-well) / <alpha-value>)',           // 设置页行容器
        pop: 'rgb(var(--fc-pop) / <alpha-value>)',             // 弹层

        // ---- 语义色重定向：红/琥珀/翠绿在浅色主题下必须压深，否则白底上看不清 ----
        // 300/400 两档是原本「深色背景专用」的浅色文字色。深色主题里它们保持原值，
        // 浅色主题里整体映射到 600/700 档，让 90 多处调用点一处不用改。
        red: {
          200: 'rgb(var(--fc-red-strong) / <alpha-value>)',
          300: 'rgb(var(--fc-red-text) / <alpha-value>)',
          400: 'rgb(var(--fc-red-text) / <alpha-value>)',
          500: 'rgb(var(--fc-red-base) / <alpha-value>)'
        },
        amber: {
          200: 'rgb(var(--fc-amber-strong) / <alpha-value>)',
          300: 'rgb(var(--fc-amber-text) / <alpha-value>)',
          400: 'rgb(var(--fc-amber-text) / <alpha-value>)',
          500: 'rgb(var(--fc-amber-base) / <alpha-value>)'
        },
        emerald: {
          300: 'rgb(var(--fc-emerald-text) / <alpha-value>)',
          400: 'rgb(var(--fc-emerald-text) / <alpha-value>)',
          500: 'rgb(var(--fc-emerald-base) / <alpha-value>)',
          600: 'rgb(var(--fc-emerald-base) / <alpha-value>)'
        },
        neutral: {
          300: 'rgb(var(--fc-mute) / <alpha-value>)',
          500: 'rgb(var(--fc-mute) / <alpha-value>)'
        }
      },
      fontFamily: {
        // 0.32.8：等宽字统一走 CSS 变量（Cascadia Code 优先），各处 font-mono 自动跟随
        mono: ['var(--ui-font-mono)'],
        kai: ['KaiTi', 'STKaiti', '楷体', 'Noto Serif SC', 'serif'],
        song: ['Noto Serif SC', 'STSong', 'SimSun', 'serif']
      }
    },
  },
  plugins: []
};
