---
name: fix-s4-deps
description: Use when audit 报 S4.cve / S4.osv / S4.pip-audit（依赖含已知漏洞），或用户提到 npm audit、依赖升级、锁安全版本、处理 breaking change 时加载。
description_en: Upgrade vulnerable dependencies to patched versions, handle breaking changes, and re-run the S4 dependency gate.
---

# 依赖升级 (fix-s4-deps)

S4 命中的标准路径：看清单定优先级 → 锁补丁版本 → 处理 breaking change → 全量测试 → 重跑 S4。`--force` 能消红但不能瞎用。

## 适用场景

- `S4.cve` / `S4.osv`：npm / pnpm lockfile 里存在已知 CVE / GHSA / OSV 条目
- `S4.pip-audit`：Python 依赖（requirements.txt / pyproject.toml）命中漏洞库
- 报告建议「锁定安全版本」或 CI 里 `npm audit` 挂掉时

## 修复步骤

1. 看清单定优先级：先处理直接依赖（direct deps）里的 high / critical；传递依赖靠 overrides 或顶层升级解决。`npm ls <pkg>` 查是谁在依赖它。
2. 锁定安全版本，优先最小改动：
   ```bash
   npm audit fix                 # 只动兼容版本（patch / minor），先跑这个
   npm audit fix --force         # 会跨大版本，先看它要改什么再决定
   npm install lodash@^4.17.21   # 定点升级某个包
   npm install pkg@latest && npm test   # 改完立刻验证
   ```
   Python：
   ```bash
   pip install "urllib3>=2.2.0"
   pip-audit -r requirements.txt      # 复核整份清单
   pip-audit                          # 或审计当前环境
   ```
3. 跨大版本先读官方 migration guide，再评估改动面：
   ```bash
   grep -rn "from 'express'\|require('express')" src/ | wc -l   # 有多少调用点
   npx depcheck                                                  # 是否有已废弃用法
   ```
   常见 breaking：express 4→5（通配路由 `app.get('*')` 语法变更）、axios 0.x→1.x（错误对象结构变更）、zod 2→3 / winston 2→3（API 收敛）。逐个调用点改完再提交。
4. 传递依赖锁不动时用 overrides 顶到补丁版：
   ```json
   // package.json
   {
     "overrides": {
       "semver": "^7.6.0",
       "got": "^12.6.1"
     }
   }
   ```
   改完 `npm install` 重新生成 lockfile，再 `npm ls <pkg>` 确认全树都指向新版本。
5. 升级后全量测试：`npm test`（pytest 则 `pytest`），红了的用例对照 changelog 逐个修——是代码要改，不是测试要删。

## 验证

- 重跑 `finalcheck audit .` 确认 S4 归零：`S4.cve`、`S4.osv`、`S4.pip-audit` 条目全部消失
- 独立复核：`npm audit --omit=dev` 与 `pip-audit` 退出码均为 0
- `npm test` / `pytest` 全绿；服务本地起得来、关键接口冒烟通过
- 有 CI 就推上去看流水线绿（若 CI 本身报 O1.no-ci，先走 10 号技能补 CI）

## 陷阱

- `npm audit fix --force` 一把梭不看 diff：可能把框架顶跨大版本（如 express 4→5），audit 归零但服务运行时炸；先看它计划改动的包列表
- 只升级不跑测试：依赖 breaking change 常在运行时才暴露，「S4 归零但登录接口 500」是最常见翻车；升级与测试必须同一次提交
- 用 `--legacy-peer-deps`、删 lockfile 或关掉 audit 脚本压告警：告警消失但漏洞包还在树里，S4 照报；掩耳盗铃不是修复
- 只修 runtime 忘了 devDependencies：构建链（webpack 插件、esbuild、tsx）的 CVE 同样进 S4 清单，且在 CI 上被利用；`npm audit` 默认包含 dev，别加 `--omit=dev` 自查后以为全修了
- overrides 写了却没重新 install：package.json 改了 lockfile 没更新，装出来的还是旧版本；改完必须 `npm install` 并提交新 lockfile
