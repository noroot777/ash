#!/bin/bash
# 编出 Navi 的 macOS app：自带 node 与 server/web/mcp 产物的一整份 Navi，加一个 WKWebView 窗口。
# 装好之后不依赖仓库检出，也不依赖系统里有没有 node。不用 Xcode 工程，只要 Xcode 命令行工具
# 里的 swiftc；打包那一步（scripts/bundle-runtime.mjs）要本机有 node 和 npm。
#
#   desktop/macos/build.sh             # 产物 desktop/macos/build/Navi.app
#   desktop/macos/build.sh --install   # 装进 /Applications（不可写就 ~/Applications）并打开；旧版还有进程在用就不装
#   desktop/macos/build.sh --dmg       # 另出一份拖进「应用程序」安装的 build/Navi.dmg（与发版同一个 dmg 格式）
#
# 自更新（Sparkle）的更新源和 EdDSA 公钥取自 release.json；公钥还空着时编出来的 app 不带更新源，
# 「检查更新…」不出现。演练与测试用的口子（正式发版不用）：
#   NAVI_MAC_FEED_URL / NAVI_MAC_ED_PUBLIC_KEY  换更新源和公钥（本机 http 托的 appcast + 演练密钥）
#   NAVI_MAC_BUNDLE_ID                         换 bundle id：defaults、数据根、登录项都跟着分开
#   NAVI_MAC_BUILD_NUMBER                      指定 CFBundleVersion，造一新一旧两个版本
# 这几个口子改名前叫 ASH_MAC_*，旧名照样认、新名优先（下面读的时候各退一档）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/build"
APP="$BUILD/Navi.app"
# 给人看的版本。Sparkle 比的是下面的 CFBundleVersion。
VERSION="0.3.1"
# CFBundleVersion 必须严格递增：账本记着这台机器上发过的最后一个号，新号一定比它大（规则见
# scripts/build-number.mjs）。账本放在仓库的 git 公共目录里，各个 worktree 共用一本；不在仓库里构建时
# 退回 build/ 下。
cd "$HERE"
LEGACY_BOOK=""
if COMMON="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
  BOOK="$COMMON/navi-mac-build-number"
  LEGACY_BOOK="$COMMON/ash-mac-build-number"
else
  BOOK="$BUILD/.build-number"
fi
BOOK_OVERRIDE="${NAVI_MAC_BUILD_NUMBER_FILE:-${ASH_MAC_BUILD_NUMBER_FILE:-}}"
[[ -n "$BOOK_OVERRIDE" ]] && BOOK="$BOOK_OVERRIDE" LEGACY_BOOK=""
mkdir -p "$(dirname "$BOOK")"
touch "$BOOK"
# NAVI_MAC_BUILD_NUMBER 指定时不碰账本（演练造一新一旧两版用）。改名前的账本（ash-mac-build-number）在锁里当底读，见 build-number.mjs。
BUILD_NUMBER="${NAVI_MAC_BUILD_NUMBER:-${ASH_MAC_BUILD_NUMBER:-}}"
BUILD_NUMBER="${BUILD_NUMBER:-$(lockf -k "$BOOK" node "$HERE/scripts/build-number.mjs" "$BOOK" ${LEGACY_BOOK:+"$LEGACY_BOOK"})}"
# 包标识改名前是 dev.ash.mac：已装的旧版怎么接到这一版，见 Sources/LegacyIdentity.swift 和 README「从 Ash.app 升级」。
BUNDLE_ID="${NAVI_MAC_BUNDLE_ID:-${ASH_MAC_BUNDLE_ID:-}}"
BUNDLE_ID="${BUNDLE_ID:-dev.navi.mac}"

# 更新源：release.json 里放 appcast 的那个仓库（feedRepo，不是放安装包的 releaseRepo）→
# raw.githubusercontent 上那份 appcast。
RELEASE_CONFIG="$(node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!c.feedRepo) { console.error("✕ release.json 里没有 feedRepo"); process.exit(1); }
  console.log(c.feedRepo, c.feedBranch || "main", c.appcastPath || "appcast.xml", c.publicKey || "-");' "$HERE/release.json")"
read -r FEED_REPO FEED_BRANCH FEED_APPCAST RELEASE_KEY <<< "$RELEASE_CONFIG"
FEED_URL="${NAVI_MAC_FEED_URL:-${ASH_MAC_FEED_URL:-}}"
FEED_URL="${FEED_URL:-https://raw.githubusercontent.com/$FEED_REPO/$FEED_BRANCH/$FEED_APPCAST}"
ED_KEY="${NAVI_MAC_ED_PUBLIC_KEY:-${ASH_MAC_ED_PUBLIC_KEY:-}}"
ED_KEY="${ED_KEY:-$RELEASE_KEY}"
[[ "$ED_KEY" == "-" ]] && ED_KEY=""

# 自带的 node 是 darwin-arm64 那一份，node-pty 也按本机架构现编，所以只在 Apple 芯片上出包。
if [[ "$(uname -m)" != arm64 ]]; then
  echo "✕ 只支持在 Apple 芯片（arm64）的 Mac 上构建" >&2
  exit 1
fi

SPARKLE="$(node "$HERE/scripts/sparkle.mjs")"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
cp "$HERE/../../docs/logo/loader.svg" "$APP/Contents/Resources/loader.svg"

swiftc -O -swift-version 5 -target arm64-apple-macos14.0 \
  -framework AppKit -framework WebKit -F "$SPARKLE" -framework Sparkle \
  -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
  "$HERE"/Sources/*.swift -o "$APP/Contents/MacOS/Navi"
# 框架原样放进去（ditto 保住里面的软链和 Sparkle 自己的签名）。
ditto "$SPARKLE/Sparkle.framework" "$APP/Contents/Frameworks/Sparkle.framework"

# 图标现画现转，结果缓存在 build/ 里；改了 make-icon.swift 或它画的那张 icon.svg 就重画。
ICNS="$BUILD/AppIcon.icns"
ICON_SVG="$HERE/../../docs/logo/icon.svg"
if [[ ! -f "$ICNS" || "$HERE/scripts/make-icon.swift" -nt "$ICNS" || "$ICON_SVG" -nt "$ICNS" ]]; then
  rm -rf "$BUILD/AppIcon.iconset"
  swift "$HERE/scripts/make-icon.swift" "$ICON_SVG" "$BUILD/AppIcon.iconset"
  iconutil -c icns "$BUILD/AppIcon.iconset" -o "$ICNS"
fi
cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"
# 改名前的 Ash.app 让位时判「还有没有人在用」，用的是安装器同一份判据（LegacyIdentity.retire）。
cp "$HERE/scripts/bundle-users.sh" "$APP/Contents/Resources/bundle-users.sh"

# 自带的那份 Navi：node、产物、生产依赖 → Contents/Resources/app。
node "$HERE/scripts/bundle-runtime.mjs" "$APP/Contents/Resources"

# Sparkle：只认 EdDSA（app 是 ad-hoc 签名，没有能延续的 Apple 签名身份），appcast 本身也要签过；
# 先验签再解包。定时检查每 6 小时一次；检查到了先问，装之前过 UpdateGate 那道闸。
SPARKLE_KEYS=""
if [[ -n "$ED_KEY" ]]; then
  SPARKLE_KEYS="  <key>SUFeedURL</key><string>$FEED_URL</string>
  <key>SUPublicEDKey</key><string>$ED_KEY</string>
  <key>SURequireSignedFeed</key><true/>
  <key>SUVerifyUpdateBeforeExtraction</key><true/>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SUScheduledCheckInterval</key><integer>21600</integer>"
fi

# ATS：页面走 http 连本机 / 局域网的 Navi，所以放开本地网络与 web 内容里的明文加载。
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>Navi</string>
  <key>CFBundleDisplayName</key><string>Navi</string>
  <key>CFBundleExecutable</key><string>Navi</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>NaviSourceCommit</key><string>$(git rev-parse --short HEAD 2>/dev/null || echo unknown)</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>$BUNDLE_ID</string>
      <key>CFBundleURLSchemes</key><array><string>navi</string></array>
    </dict>
  </array>
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
node "$HERE/scripts/runtime-store.mjs" seal "$APP/Contents/Resources/app" >/dev/null
codesign --force --sign - "$APP" 2>/dev/null
codesign --verify --deep --strict "$APP"
echo "✓ ${APP}（${VERSION} / ${BUILD_NUMBER}）"
[[ -n "$ED_KEY" ]] || echo "  （release.json 里还没有 EdDSA 公钥：这一份不带自更新）"

case "${1:-}" in
  --install)
    DEST_DIR="/Applications"
    [[ -w "$DEST_DIR" ]] || DEST_DIR="$HOME/Applications"
    osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
    # 窗口退出要一会儿；install-app.sh 会停掉空闲服务，仍有任务或 MCP 在用旧包就不装。
    # 认的是可执行文件的真实路径（lsof 报解析后的路径），装在别名目录下、路径带特殊字符都认得出。
    GUI="$(cd "$DEST_DIR/Navi.app/Contents/MacOS" 2>/dev/null && pwd -P)/Navi" || GUI=""
    for _ in $(seq 1 50); do
      [[ -n "$GUI" ]] && lsof -nP -w -a -d txt -c Navi -F n 2>/dev/null | grep -qxF "n$GUI" || break
      sleep 0.2
    done
    bash "$HERE/scripts/install-app.sh" "$APP" "$DEST_DIR" --open
    ;;
  --dmg)
    bash "$HERE/scripts/make-dmg.sh" "$APP" "$BUILD/Navi.dmg"
    echo "✓ $BUILD/Navi.dmg"
    ;;
esac
