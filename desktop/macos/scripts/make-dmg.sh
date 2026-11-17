#!/bin/bash
# 把一份 Ash.app 封成 dmg：同一个文件既给人下载安装，也是 Sparkle 的更新包。build.sh --dmg 和发版都用它。
#
#   desktop/macos/scripts/make-dmg.sh <Ash.app> <输出.dmg>
#
# 卷里只有 Ash.app、一个指向 /Applications 的软链和 Finder 布局（.DS_Store，见 make-dmg-layout.py）：
# 打开就是「把 ash 拖进应用程序」那扇窗口。Sparkle 挂载更新包时跳过隐藏文件和软链，只拷出 .app
# （Sparkle 2.10.1 的 SUDiskImageUnarchiver），所以这两样不碍更新。
# 不签 dmg：app 是 ad-hoc 签名，没有 Developer ID，dmg 签了 Sparkle 也不认；更新包只认 EdDSA。
# 格式 UDZO（zlib 压缩的只读镜像）：macOS 14 以上 hdiutil 都挂得上；不带许可协议，挂载不问话。
set -euo pipefail

APP="${1:?用法：make-dmg.sh <Ash.app> <输出.dmg>}"
OUT="${2:?用法：make-dmg.sh <Ash.app> <输出.dmg>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
[[ -d "$APP/Contents" ]] || { echo "✕ $APP 不是一个 .app" >&2; exit 1; }

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/ash-dmg.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
# 卷里的名字固定叫 Ash.app（布局按这个名字摆图标），不管源目录叫什么。
ditto "$APP" "$STAGE/Ash.app"
ln -s /Applications "$STAGE/Applications"
cp "$HERE/../dmg/DS_Store" "$STAGE/.DS_Store"
rm -f "$OUT"
hdiutil create -quiet -volname ash -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$OUT"
