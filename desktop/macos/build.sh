#!/bin/bash
# 编出 ash 的 macOS app：自带 node 与 server/web/mcp 产物的一整份 ash，加一个 WKWebView 窗口。
# 装好之后不依赖仓库检出，也不依赖系统里有没有 node。不用 Xcode 工程，只要 Xcode 命令行工具
# 里的 swiftc；打包那一步（scripts/bundle-runtime.mjs）要本机有 node 和 npm。
#
#   desktop/macos/build.sh             # 产物 desktop/macos/build/Ash.app
#   desktop/macos/build.sh --install   # 装进 /Applications（不可写就 ~/Applications）并打开；旧版还有进程在用就不装
#   desktop/macos/build.sh --dmg       # 另出一份拖进「应用程序」安装的 build/Ash.dmg
#
# 自更新（Sparkle）的更新源和 EdDSA 公钥取自 release.json；公钥还空着时编出来的 app 不带更新源，
# 「检查更新…」不出现。演练与测试用的口子（正式发版不用）：
#   ASH_MAC_FEED_URL / ASH_MAC_ED_PUBLIC_KEY  换更新源和公钥（本机 http 托的 appcast + 演练密钥）
#   ASH_MAC_BUNDLE_ID                         换 bundle id：defaults、数据根、登录项都跟着分开
#   ASH_MAC_BUILD_NUMBER                      指定 CFBundleVersion，造一新一旧两个版本
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/build"
APP="$BUILD/Ash.app"
# 给人看的版本。Sparkle 比的是下面的 CFBundleVersion。
VERSION="0.2.0"
# CFBundleVersion 必须严格递增：账本记着这台机器上发过的最后一个号，新号一定比它大（规则见
# scripts/build-number.mjs）。账本放在仓库的 git 公共目录里，各个 worktree 共用一本；不在仓库里构建时
# 退回 build/ 下。
cd "$HERE"
if COMMON="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
  BOOK="$COMMON/ash-mac-build-number"
else
  BOOK="$BUILD/.build-number"
fi
BOOK="${ASH_MAC_BUILD_NUMBER_FILE:-$BOOK}"
mkdir -p "$(dirname "$BOOK")"
touch "$BOOK"
# ASH_MAC_BUILD_NUMBER 指定时不碰账本（演练造一新一旧两版用）。
BUILD_NUMBER="${ASH_MAC_BUILD_NUMBER:-$(lockf -k "$BOOK" node "$HERE/scripts/build-number.mjs" "$BOOK")}"
BUNDLE_ID="${ASH_MAC_BUNDLE_ID:-dev.ash.mac}"

# 更新源：release.json 里的发布仓库 → raw.githubusercontent 上那份 appcast。
read -r RELEASE_REPO RELEASE_BRANCH RELEASE_APPCAST RELEASE_KEY < <(node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(c.repo, c.branch || "main", c.appcastPath || "appcast.xml", c.publicKey || "-");' "$HERE/release.json")
FEED_URL="${ASH_MAC_FEED_URL:-https://raw.githubusercontent.com/$RELEASE_REPO/$RELEASE_BRANCH/$RELEASE_APPCAST}"
ED_KEY="${ASH_MAC_ED_PUBLIC_KEY:-$RELEASE_KEY}"
[[ "$ED_KEY" == "-" ]] && ED_KEY=""

# 自带的 node 是 darwin-arm64 那一份，node-pty 也按本机架构现编，所以只在 Apple 芯片上出包。
if [[ "$(uname -m)" != arm64 ]]; then
  echo "✕ 只支持在 Apple 芯片（arm64）的 Mac 上构建" >&2
  exit 1
fi

SPARKLE="$(node "$HERE/scripts/sparkle.mjs")"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"

swiftc -O -swift-version 5 -target arm64-apple-macos14.0 \
  -framework AppKit -framework WebKit -F "$SPARKLE" -framework Sparkle \
  -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
  "$HERE"/Sources/*.swift -o "$APP/Contents/MacOS/Ash"
# 框架原样放进去（ditto 保住里面的软链和 Sparkle 自己的签名）。
ditto "$SPARKLE/Sparkle.framework" "$APP/Contents/Frameworks/Sparkle.framework"

# 图标现画现转，结果缓存在 build/ 里；改了 make-icon.swift 就重画。
ICNS="$BUILD/AppIcon.icns"
if [[ ! -f "$ICNS" || "$HERE/scripts/make-icon.swift" -nt "$ICNS" ]]; then
  rm -rf "$BUILD/AppIcon.iconset"
  swift "$HERE/scripts/make-icon.swift" "$BUILD/AppIcon.iconset"
  iconutil -c icns "$BUILD/AppIcon.iconset" -o "$ICNS"
fi
cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"

# 自带的那份 ash：node、产物、生产依赖 → Contents/Resources/app。
node "$HERE/scripts/bundle-runtime.mjs" "$APP/Contents/Resources"

# Sparkle：只认 EdDSA（app 是 ad-hoc 签名，没有能延续的 Apple 签名身份），appcast 本身也要签过；
# 先验签再解压。定时检查每 6 小时一次；检查到了先问，装之前过 UpdateGate 那道闸。
SPARKLE_KEYS=""
if [[ -n "$ED_KEY" ]]; then
  SPARKLE_KEYS="  <key>SUFeedURL</key><string>$FEED_URL</string>
  <key>SUPublicEDKey</key><string>$ED_KEY</string>
  <key>SURequireSignedFeed</key><true/>
  <key>SUVerifyUpdateBeforeExtraction</key><true/>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SUScheduledCheckInterval</key><integer>21600</integer>"
fi

# ATS：页面走 http 连本机 / 局域网的 ash，所以放开本地网络与 web 内容里的明文加载。
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>ash</string>
  <key>CFBundleDisplayName</key><string>ash</string>
  <key>CFBundleExecutable</key><string>Ash</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>AshSourceCommit</key><string>$(git rev-parse --short HEAD 2>/dev/null || echo unknown)</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
$SPARKLE_KEYS
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key><true/>
  </dict>
</dict>
</plist>
PLIST

# node 保留 nodejs.org 的官方签名；node-pty 是本机现编的（链接器已给 ad-hoc 签名），再按 ad-hoc
# 签一遍，最后封整个 app。
find "$APP/Contents/Resources/app/node_modules/node-pty/build/Release" -type f \( -name '*.node' -o -name spawn-helper \) \
  -exec codesign --force --sign - {} + 2>/dev/null
codesign --force --sign - "$APP" 2>/dev/null
codesign --verify --deep --strict "$APP"
echo "✓ ${APP}（${VERSION} / ${BUILD_NUMBER}）"
[[ -n "$ED_KEY" ]] || echo "  （release.json 里还没有 EdDSA 公钥：这一份不带自更新）"

case "${1:-}" in
  --install)
    DEST_DIR="/Applications"
    [[ -w "$DEST_DIR" ]] || DEST_DIR="$HOME/Applications"
    osascript -e 'tell application id "dev.ash.mac" to quit' >/dev/null 2>&1 || true
    # 窗口退出要一会儿；服务和 agent 的 MCP 不随它退，install-app.sh 见到还有人在用就不装。
    # 认的是可执行文件的真实路径（lsof 报解析后的路径），装在别名目录下、路径带特殊字符都认得出。
    GUI="$(cd "$DEST_DIR/Ash.app/Contents/MacOS" 2>/dev/null && pwd -P)/Ash" || GUI=""
    for _ in $(seq 1 50); do
      [[ -n "$GUI" ]] && lsof -nP -w -a -d txt -c Ash -F n 2>/dev/null | grep -qxF "n$GUI" || break
      sleep 0.2
    done
    bash "$HERE/scripts/install-app.sh" "$APP" "$DEST_DIR"
    open "$DEST_DIR/Ash.app"
    ;;
  --dmg)
    STAGE="$BUILD/dmg"
    rm -rf "$STAGE" "$BUILD/Ash.dmg"
    mkdir -p "$STAGE"
    ditto "$APP" "$STAGE/Ash.app"
    ln -s /Applications "$STAGE/Applications"
    hdiutil create -quiet -volname ash -srcfolder "$STAGE" -ov -format UDZO "$BUILD/Ash.dmg"
    rm -rf "$STAGE"
    echo "✓ $BUILD/Ash.dmg"
    ;;
esac
