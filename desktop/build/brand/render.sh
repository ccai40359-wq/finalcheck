#!/bin/sh
# 用法：render.sh in.svg|in.html out.png W H
# 用一次性的临时 Edge 配置目录无头截图，不碰用户自己的浏览器配置。
# 注意：Windows 上 msedge 不接管道时会立刻脱离返回，截图还没写完——所以输出必须接 cat 等它退出。
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
PROFILE=$(mktemp -d)
"$EDGE" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$(cygpath -w "$PROFILE")" \
  --default-background-color=00000000 --window-size="$3,$4" --screenshot="$(cygpath -w "$2")" \
  "file:///$(cygpath -m "$(realpath "$1")")" 2>&1 | cat >/dev/null
sleep 1; rm -rf "$PROFILE" 2>/dev/null || true
