#!/bin/bash
# 还有哪些进程在用某个 .app：desktop/macos/scripts/bundle-users.sh <Ash.app>
# 每行「pid 命令行」，没人用就什么都不打。bundle 不存在时也什么都不打。
#
# 认的是文件身份，不是路径拼写（第 2 轮审查 F3）：同一个 bundle 可以经软链、目录别名被拉起，
# 路径里还可能带正则字符，拿目标路径去 `pgrep -f` 两样都会漏。两条线索，任一条落在 bundle 的
# 真实路径之下就算在用：
#   · 可执行文件、映射进来的库（node-pty 的 .node）、工作目录 —— lsof 报的是解析后的真实路径。
#     跑 bundle 自带 node 的服务和 MCP、Ash 本身都在这一条上。只看这几类，不看普通打开的文件：
#     Finder、Spotlight 读一下图标、索引一下内容不算「在用」；
#   · 命令行里提到的每一个 .app，逐个按真实路径解析 —— 用别处的 node 跑 bundle 里脚本的那种，
#     脚本读完就关了，lsof 看不见它。
set -uo pipefail

REAL="$(cd "$1" 2>/dev/null && pwd -P)" || exit 0
users="$(lsof -nP -w -a -d txt,cwd -F pn 2>/dev/null | awk -v root="$REAL/" '
  /^p/ { pid = substr($0, 2) }
  /^n/ { if (index(substr($0, 2) "/", root) == 1) print pid }')"

while read -r pid cmd; do
  [[ "$cmd" == *.app/* ]] || continue
  rest="$cmd"
  while [[ "$rest" == *.app/* ]]; do
    # 这一处 .app 往前，每个「前面是空白、= 或引号」的 / 都可能是路径的起点（路径里本身可能有空格）。
    candidate="${rest%%.app/*}.app"
    candidate="${candidate//[=\"\']/ }"
    rest="${rest#*.app/}"
    while :; do
      if [[ "$candidate" == /* && "$(cd "$candidate" 2>/dev/null && pwd -P)" == "$REAL" ]]; then
        users+=$'\n'"$pid"
        break 2
      fi
      [[ "$candidate" == *" /"* ]] || break
      candidate="/${candidate#* /}"
    done
  done
done < <(ps -axww -o pid=,command=)

for pid in $(printf '%s\n' "$users" | grep -E '^[0-9]+$' | sort -un); do
  # 自己和调用自己的安装脚本不算。
  [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
  ps -o pid=,command= -p "$pid" 2>/dev/null | sed 's/^ *//'
done
exit 0
