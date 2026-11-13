#!/bin/bash
# 把编好的 Ash.app 换进安装目录：desktop/macos/scripts/install-app.sh <新的 Ash.app> <安装目录>
#
# 退出 app 不停服务（服务、agent 拉起的 ash MCP 都跑在 bundle 里的 node 和代码上）。这时把 bundle
# 换掉，长驻的 node 已经加载的模块还是旧的，之后才加载的模块、静态资源、新起的 MCP 却读到新版本，
# 一次运行里新旧混着跑；拷到一半失败还会把它们正用着的代码目录整个丢掉。所以：
#   · 删任何东西之前先查还有没有进程在用目标 bundle（按真实文件身份认，别名、软链、路径里的
#     特殊字符都不影响，见 bundle-users.sh），有就不装，说清是谁、怎么停；
#   · 同一个安装目录同一时刻只有一个安装在换（按目录的真实路径加锁，两个安装器排队）；
#   · 新版先完整拷到旁边，再两次改名换上，拷失败、最后一步失败时旧的那份放回原处。
set -euo pipefail

APP="$1"
DEST_DIR="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
[[ -d "$APP" ]] || { echo "✕ 没有 ${APP}" >&2; exit 1; }
mkdir -p "$DEST_DIR"

if [[ -z "${ASH_INSTALL_LOCKED:-}" ]]; then
  LOCK="${TMPDIR:-/tmp}/ash-install-$(md5 -qs "$(cd "$DEST_DIR" && pwd -P)").lock"
  ASH_INSTALL_LOCKED=1 exec lockf -k -t 600 "$LOCK" /bin/bash "$0" "$@"
fi

DEST="$DEST_DIR/Ash.app"

refuse_if_in_use() {
  local users
  users="$(/bin/bash "$HERE/bundle-users.sh" "$1")"
  [[ -z "$users" ]] && return 0
  echo "✕ 没有安装：下面这些进程还在用 ${DEST} 里的代码，现在换掉会让它们新旧代码混着跑。" >&2
  printf '%s\n' "$users" | sed 's/^/    /' >&2
  echo "  ash 服务（server/dist/index.js 那一行）：手上没有在跑的任务时 kill 它（agent 不会跟着停）；" >&2
  echo "  ash MCP（mcp/dist/index.js）是在跑的 agent 拉起的，等那几个任务这一轮结束；Ash 本身先退出。" >&2
  echo "  都停了再装一次。" >&2
  return 1
}

if [[ -e "$DEST" ]] && ! refuse_if_in_use "$DEST"; then exit 1; fi

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
if [[ -e "$DEST" ]]; then
  # 拷的这段时间里又有人从旧 bundle 起了进程（登录项、另一个窗口）：不装。挪开之前认一遍（命令行
  # 里的路径这时还解析得到），挪开之后再按打开着的文件认一遍，中间那一下挪开的空档里起的也漏不掉。
  refuse_if_in_use "$DEST" || exit 1
  mv "$DEST" "$OLD"
  refuse_if_in_use "$OLD" || exit 1
fi
mv "$STAGE" "$DEST"
rm -rf "$OLD"
echo "✓ $DEST"
