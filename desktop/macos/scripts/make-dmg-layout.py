# 生成 dmg 打开时那扇「把 ash 拖进应用程序」窗口的 Finder 布局：desktop/macos/dmg/DS_Store。
# 产物入库，make-dmg.sh 只是把它拷成卷根的 .DS_Store，出包不要 Finder、不要 AppleScript、也不联网。
# 改布局才需要重跑：
#
#   uv run --with ds-store==1.3.1 python3 desktop/macos/scripts/make-dmg-layout.py
#
# 布局只按文件名认图标（Ash.app、Applications），没有背景图，所以不含指向卷的别名，换卷名也照样生效。
import plistlib
import sys
from pathlib import Path

from ds_store import DSStore

WIDTH, HEIGHT = 540, 360
OUT = Path(__file__).resolve().parent.parent / "dmg" / "DS_Store"
OUT.unlink(missing_ok=True)

window = {
    "WindowBounds": f"{{{{200, 160}}, {{{WIDTH}, {HEIGHT}}}}}",
    "ContainerShowSidebar": False,
    "ShowSidebar": False,
    "ShowToolbar": False,
    "ShowTabView": False,
    "ShowPathbar": False,
    "ShowStatusBar": False,
    "SidebarWidth": 0,
    "PreviewPaneVisibility": False,
}
icons = {
    "viewOptionsVersion": 1,
    "backgroundType": 0,
    "backgroundColorRed": 1.0,
    "backgroundColorGreen": 1.0,
    "backgroundColorBlue": 1.0,
    "iconSize": 128.0,
    "textSize": 13.0,
    "gridSpacing": 100.0,
    "gridOffsetX": 0.0,
    "gridOffsetY": 0.0,
    "labelOnBottom": True,
    "showItemInfo": False,
    "showIconPreview": True,
    "arrangeBy": "none",
}

with DSStore.open(str(OUT), "w+") as store:
    store["."]["vSrn"] = ("long", 1)
    store["."]["bwsp"] = window
    store["."]["icvp"] = icons
    store["Ash.app"]["Iloc"] = (140, 160)
    store["Applications"]["Iloc"] = (400, 160)

with DSStore.open(str(OUT), "r") as store:
    entries = sorted((entry.filename, entry.code.decode()) for entry in store)
sys.stdout.write(f"✓ {OUT}\n  {entries}\n")
