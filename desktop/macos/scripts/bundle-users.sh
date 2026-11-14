#!/bin/bash
# 还有哪些进程在用某个 .app：desktop/macos/scripts/bundle-users.sh <Ash.app>
# 每行「pid 命令行」，没人用就什么都不打。bundle 不存在时也什么都不打。
#
# 认的是文件身份，不是路径拼写：同一个 bundle 可以经软链、目录别名、相对路径被拉起，路径里还
# 可能带正则字符。三条线索，任一条落在 bundle 的真实路径之下就算在用：
#   · 拿着代码锁的（shared/src/code-lock.ts）：服务、ash MCP 不管被谁、从哪个路径、用哪个 node 拉起，
#     读业务代码之前都先以共享锁打开 bundle 里的 `.in-use`，一直拿到进程结束。锁在文件本身上，包
#     改名之后照样认得出；进程死了内核就放锁，不会留下死登记。安装器判「有没有人用」靠的是对它拿
#     排他锁（install-app.sh），这里只负责说清是谁；
#   · 可执行文件、映射进来的库（node-pty 的 .node）、工作目录 —— lsof 报的是解析后的真实路径。
#     只看这几类，不看普通打开的文件：Finder、Spotlight 读一下图标、索引一下内容不算「在用」；
#   · 命令行里提到的每一个 .app，绝对路径直接解析，相对路径按那个进程的工作目录解析。
# ASH_LOCK_HOLDER=<pid>：安装器自己拿着排他锁的那个进程，不算。
set -uo pipefail

REAL="$(cd "$1" 2>/dev/null && pwd -P)" || exit 0
users=""

LOCK="$REAL/Contents/Resources/app/.in-use"
[[ -f "$LOCK" ]] && users+=$'\n'"$(lsof -nP -w -t -- "$LOCK" 2>/dev/null)"

users+=$'\n'"$(lsof -nP -w -a -d txt,cwd -F pn 2>/dev/null | awk -v root="$REAL/" '
  /^p/ { pid = substr($0, 2) }
  /^n/ { if (index(substr($0, 2) "/", root) == 1) print pid }')"

resolves_here() {
  [[ "$(cd "$1" 2>/dev/null && pwd -P)" == "$REAL" ]]
}

while read -r pid cmd; do
  [[ "$cmd" == *.app/* ]] || continue
  cwd=""
  rest="$cmd"
  while [[ "$rest" == *.app/* ]]; do
    # 这一处 .app 往前，每个「前面是空白、= 或引号」的位置都可能是路径的起点（路径里本身可能有空格）。
    candidate="${rest%%.app/*}.app"
    candidate="${candidate//[=\"\']/ }"
    rest="${rest#*.app/}"
    while :; do
      if [[ "$candidate" == /* ]]; then
        resolves_here "$candidate" && { users+=$'\n'"$pid"; break 2; }
      elif [[ -n "$candidate" ]]; then
        [[ -n "$cwd" ]] || cwd="$(lsof -nP -w -a -p "$pid" -d cwd -F n 2>/dev/null | sed -n 's/^n//p')"
        [[ -n "$cwd" ]] && resolves_here "$cwd/$candidate" && { users+=$'\n'"$pid"; break 2; }
      fi
      [[ "$candidate" == *" "* ]] || break
      candidate="${candidate#* }"
    done
  done
done < <(ps -axww -o pid=,command=)

for pid in $(printf '%s\n' "$users" | grep -E '^[0-9]+$' | sort -un); do
  # 自己、调用自己的安装脚本、安装器拿着排他锁的那个进程不算。
  [[ "$pid" == "$$" || "$pid" == "$PPID" || "$pid" == "${ASH_LOCK_HOLDER:-}" ]] && continue
  ps -o pid=,command= -p "$pid" 2>/dev/null | sed 's/^ *//'
done
exit 0
