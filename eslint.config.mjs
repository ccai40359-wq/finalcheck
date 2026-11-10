// ESLint 9 flat config — 只做少而准的静态检查。
// 覆盖范围刻意收窄到 ESM 脚本（.mjs），暂不 lint 渲染层 JSX。
import globals from 'globals'

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
]
