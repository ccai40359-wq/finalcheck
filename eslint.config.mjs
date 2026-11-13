// ESLint 9 flat config — 只做少而准的静态检查。
// .mjs 走完整三条规则；.jsx 只开 no-shadow + react-hooks（不开 no-unused-vars/no-undef：
// 核心规则不认 JSX 组件引用，会在 27 个渲染文件里产生 100+ 假阳性）。
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'

// 本月真实踩过的 bug 类型：局部 `const t` 遮蔽 i18n 的 `t()`。
const correctnessRules = {
  'no-shadow': 'error',
  'no-unused-vars': [
    'error',
    { args: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' },
  ],
  'no-undef': 'error',
}

export default [
  {
    ignores: [
      'node_modules/**',
      '.playwright-mcp/**',
      '.tools/**',
      '.mimosa/**',
      'out/**',
      'desktop/out/**',
      'desktop/release*/**',
      'desktop/dist-staging/**',
      'desktop/_recon/**',
      'desktop/.tmp/**', // 临时构建/UI 自检产物（git 已忽略 .tmp/），不该进 lint
      'playbooks/**',
      'src/fixtures/**',
      'tests/fixtures/**',
      '.tmp/**',
      'tmp-redteam/**',
      'dist/**',
    ],
  },
  {
    files: [
      'src/**/*.mjs',
      'desktop/src/main/**/*.mjs',
      'tests/**/*.mjs',
      'scripts/**/*.mjs',
      'bin/**/*.mjs',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: correctnessRules,
  },
  {
    // 渲染层 JSX：只查真实踩过的 bug 类型（t() 被局部变量遮蔽 + hooks 规则）。
    files: ['desktop/src/renderer/**/*.jsx'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'no-shadow': 'error',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
]
