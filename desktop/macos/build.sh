#!/bin/bash
# 编出 ash 的 macOS 壳：一个 WKWebView 窗口，连 :4317（或 ASH_URL / defaults 里的 AshURL）。
# 不用 Xcode 工程，只要 Xcode 命令行工具里的 swiftc。
#
#   desktop/macos/build.sh             # 产物 desktop/macos/build/Ash.app
#   desktop/macos/build.sh --install   # 另拷一份到 ~/Applications/Ash.app 并打开
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/build"
APP="$BUILD/Ash.app"
VERSION="0.1.0"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos14.0" \
  -framework AppKit -framework WebKit \
  "$HERE"/Sources/*.swift -o "$APP/Contents/MacOS/Ash"

# 图标现画现转，结果缓存在 build/ 里；改了 make-icon.swift 就重画。
ICNS="$BUILD/AppIcon.icns"
if [[ ! -f "$ICNS" || "$HERE/scripts/make-icon.swift" -nt "$ICNS" ]]; then
  rm -rf "$BUILD/AppIcon.iconset"
  swift "$HERE/scripts/make-icon.swift" "$BUILD/AppIcon.iconset"
  iconutil -c icns "$BUILD/AppIcon.iconset" -o "$ICNS"
fi
cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"

# ATS：页面走 http 连本机 / 局域网的 ash，所以放开本地网络与 web 内容里的明文加载。
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.ash.mac</string>
  <key>CFBundleName</key><string>ash</string>
  <key>CFBundleDisplayName</key><string>ash</string>
  <key>CFBundleExecutable</key><string>Ash</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo 0)</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key><true/>
  </dict>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" >/dev/null
echo "✓ $APP"

if [[ "${1:-}" == "--install" ]]; then
  DEST="$HOME/Applications/Ash.app"
  mkdir -p "$HOME/Applications"
  osascript -e 'tell application id "dev.ash.mac" to quit' >/dev/null 2>&1 || true
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  echo "✓ $DEST"
  open "$DEST"
fi
