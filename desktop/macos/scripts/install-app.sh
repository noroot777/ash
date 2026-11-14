#!/bin/bash
# 把编好的 Ash.app 换进安装目录：desktop/macos/scripts/install-app.sh <新的 Ash.app> <安装目录>
#
# 退出 app 不停服务（服务、agent 拉起的 ash MCP 都跑在 bundle 里的 node 和代码上）。这时把 bundle
# 换掉，长驻的 node 已经加载的模块还是旧的，之后才加载的模块、静态资源、新起的 MCP 却读到新版本，
# 一次运行里新旧混着跑；拷到一半失败还会把它们正用着的代码目录整个丢掉。所以：
#   · 换包和进程启动共用一把锁（shared/src/code-lock.ts）：跑包里代码的服务、MCP 一直以共享锁拿着
#     bundle 里的 `.in-use`；换包时对它拿排他锁，**从最后一次检查一直拿到换完** —— 拿不到就是有人
#     在用，不装、说清是谁、怎么停；拿到了，这期间想起来的进程在锁上等，等到时包已经换好。查和换
#     之间没有空档，也不靠「扫不到」证明没人用。锁跟着文件走，包改名之后照样有效；
#   · 锁管不到的（Ash 本身、别的程序拿包里的可执行文件跑）另按真实文件身份扫一遍（bundle-users.sh）；
#   · 同一个安装目录同一时刻只有一个安装在换（按目录的真实路径加锁，两个安装器排队）；
#   · 新版先完整拷到旁边，再两次改名换上，拷失败、最后一步失败时旧的那份放回原处。
# 已经装着的是还没有代码锁的旧版 app 时只能靠扫，这一次的保证退回到扫描那一档。
set -euo pipefail

APP="$1"
DEST_DIR="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$DEST_DIR/Ash.app"
CODE_LOCK="Contents/Resources/app/.in-use"

refuse_if_in_use() {
  local users
  users="$(/bin/bash "$HERE/bundle-users.sh" "$1")"
  [[ -z "$users" ]] && return 0
  explain_in_use "$users"
  return 1
}

explain_in_use() {
  echo "✕ 没有安装：下面这些进程还在用 ${DEST} 里的代码，现在换掉会让它们新旧代码混着跑。" >&2
  printf '%s\n' "$1" | sed 's/^/    /' >&2
  echo "  ash 服务（server/dist/index.js 那一行）：手上没有在跑的任务时 kill 它（agent 不会跟着停）；" >&2
  echo "  ash MCP（mcp/dist/index.js）是在跑的 agent 拉起的，等那几个任务这一轮结束；Ash 本身先退出。" >&2
  echo "  都停了再装一次。" >&2
}

# 换包那一段：父进程 lockf 拿着旧包代码锁的排他锁，跑旧包代码的进程这时起不来。
if [[ "${3:-}" == --swap ]]; then
  STAGE="$4"
  OLD="$5"
  export ASH_LOCK_HOLDER="$PPID"
  # 挪开之前认一遍（命令行里的路径这时还解析得到），挪开之后再按打开着的文件认一遍。
  refuse_if_in_use "$DEST" || exit 1
  mv "$DEST" "$OLD"
  refuse_if_in_use "$OLD" || exit 1
  mv "$STAGE" "$DEST"
  exit 0
fi

[[ -d "$APP" ]] || { echo "✕ 没有 ${APP}" >&2; exit 1; }
[[ -f "$APP/$CODE_LOCK" ]] || { echo "✕ ${APP} 里没有代码锁 ${CODE_LOCK}，不是用这一版 build.sh 编出来的" >&2; exit 1; }
mkdir -p "$DEST_DIR"

if [[ -z "${ASH_INSTALL_LOCKED:-}" ]]; then
  # 锁的位置只由目标目录的真实路径决定，不跟 TMPDIR 走：两个环境不同的安装器也排在同一把锁上。
  LOCKS="${ASH_INSTALL_LOCKS:-/tmp/ash-install-locks}"
  mkdir -p "$LOCKS" && chmod 1777 "$LOCKS" 2>/dev/null || true
  LOCK="$LOCKS/$(md5 -qs "$(cd "$DEST_DIR" && pwd -P)").lock"
  ASH_INSTALL_LOCKED=1 exec lockf -k -t 600 "$LOCK" /bin/bash "$0" "$@"
fi

STAGE="$DEST_DIR/.Ash.app.installing-$$"
OLD="$DEST_DIR/.Ash.app.replaced-$$"
# 走到哪一步退出都收拾干净：旧包已经挪开、新包没换上时把旧包放回去。
restore() {
  rm -rf "$STAGE"
  if [[ -e "$OLD" ]]; then
    if [[ -e "$DEST" ]]; then rm -rf "$OLD"; else mv "$OLD" "$DEST"; fi
  fi
}
trap restore EXIT
rm -rf "$STAGE"
ditto "$APP" "$STAGE"
if [[ ! -e "$DEST" ]]; then
  mv "$STAGE" "$DEST"
elif [[ -f "$DEST/$CODE_LOCK" ]]; then
  status=0
  lockf -s -k -t 0 "$DEST/$CODE_LOCK" /bin/bash "$0" "$APP" "$DEST_DIR" --swap "$STAGE" "$OLD" || status=$?
  if (( status == 75 )); then
    # 有进程拿着代码锁。说清是谁；刚好在这一下退出了也照样不装，再装一次就好。
    users="$(/bin/bash "$HERE/bundle-users.sh" "$DEST")"
    explain_in_use "${users:-（有进程拿着代码锁，刚刚退出了；再装一次）}"
    exit 1
  fi
  (( status == 0 )) || exit "$status"
else
  refuse_if_in_use "$DEST" || exit 1
  mv "$DEST" "$OLD"
  refuse_if_in_use "$OLD" || exit 1
  mv "$STAGE" "$DEST"
fi
rm -rf "$OLD"
echo "✓ $DEST"
