# 第三方组件许可声明（Git Bash 子集）

本产品（FinalCheck）在安装包内附带 **Git Bash 的最小运行子集**，仅用于给 `run_command`
提供一致的 POSIX shell 环境（见 2026-11-16 决策 1）。附带文件清单：

```
resources/gitbash/bin/bash.exe             GNU Bash 5.x
resources/gitbash/usr/bin/msys-2.0.dll     MSYS2 运行时
resources/gitbash/usr/bin/{grep,ls,sed,awk,find,cat,sort,head,tail,wc,tr}.exe
                                           GNU coreutils / gawk / grep 等
```

## 许可与来源

| 组件 | 许可 | 上游 |
|---|---|---|
| GNU Bash (`bash.exe`) | **GPL-3.0** | https://www.gnu.org/software/bash/ |
| MSYS2 运行时 (`msys-2.0.dll`) | GPL-2.0（含例外条款） | https://www.msys2.org/ |
| grep / sed / coreutils / gawk | GPL-3.0（部分为 GPL-2.0+） | https://www.gnu.org/software/ |
| 整体分发形态 | Git for Windows | https://git-scm.com/ |

本产品**未修改**上述任何二进制文件，仅为原样再分发（verbatim redistribution）。

## GPL 合规说明

GPL 要求分发二进制时同时提供对应源码的获取方式。本产品的做法：

1. 上述二进制全部取自 [Git for Windows](https://git-scm.com/download/win) 官方发行版，未作任何修改；
2. 对应源码可从上游公开获取：
   - GNU Bash：https://ftp.gnu.org/gnu/bash/
   - MSYS2：https://github.com/msys2/MSYS2-packages
   - Git for Windows：https://github.com/git-for-windows/git
3. 本项目依据 GPL 的「聚合（mere aggregation）」条款，将上述独立程序与本产品一起分发；
   **本产品自身不因此被 GPL 传染**（GPL 只覆盖这些独立程序）。

## 如需完整许可文本

- GPL-2.0：https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt
- GPL-3.0：https://www.gnu.org/licenses/gpl-3.0.txt
- Git for Windows 随附的 `LICENSE.txt`（GPL-2.0 全文）已复制为 `gitbash-GPLv2.txt`

## 用户可以做什么

依据 GPL，任何收到本产品的人都有权：
- 获取上述组件的完整源码（来源见上）；
- 修改这些组件并在本产品之外分发其修改版（受 GPL 条款约束）；
- 本产品对这些组件的使用方式不限制用户对它们本身的权利。

---

最后更新：2026-11-16
