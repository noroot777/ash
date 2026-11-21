import AppKit
import WebKit

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else {
    fputs("FAIL: \(message)\n", stderr)
    exit(1)
  }
}

func descendants(_ view: NSView) -> [NSView] {
  [view] + view.subviews.flatMap(descendants)
}

func spin(_ seconds: TimeInterval) {
  RunLoop.main.run(until: Date().addingTimeInterval(seconds))
}

func js(_ view: WKWebView, _ source: String) -> String {
  var result: String?
  view.evaluateJavaScript(source) { value, error in
    result = error.map { "ERROR: \($0)" } ?? String(describing: value ?? "nil")
  }
  let deadline = Date().addingTimeInterval(10)
  while result == nil && Date() < deadline { spin(0.01) }
  return result ?? "TIMEOUT"
}

let app = NSApplication.shared
let previewing = CommandLine.arguments.contains("--preview")
app.setActivationPolicy(previewing ? .regular : .accessory)
app.finishLaunching()
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 680),
                      styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
window.title = "Navi · 重启预览"
window.isReleasedWhenClosed = false
window.minSize = NSSize(width: 440, height: 420)
let offline = OfflineView(frame: window.contentLayoutRect)
offline.autoresizingMask = [.width, .height]
window.contentView = offline
offline.show(title: "正在重启 Navi", detail: "正在应用访问设置，就绪后自动回到工作区。", busy: true)

final class PreviewActions: NSObject {
  @objc func restart(_ sender: Any?) {
    offline.show(title: "正在重启 Navi", detail: "正在应用访问设置，就绪后自动回到工作区。", busy: true)
  }
  @objc func failure(_ sender: Any?) {
    offline.show(title: "Navi 服务没起来", detail: "服务启动超时。请重试，或打开日志查看原因。",
                 actions: [.init(title: "日志") {}, .init(title: "重试") { self.restart(nil) }])
  }
  @objc func light(_ sender: Any?) { window.appearance = NSAppearance(named: .aqua) }
  @objc func dark(_ sender: Any?) { window.appearance = NSAppearance(named: .darkAqua) }
  @objc func small(_ sender: Any?) { window.setContentSize(NSSize(width: 440, height: 420)) }
}

let previewActions = PreviewActions()
if previewing {
  let menu = NSMenu()
  let root = NSMenuItem()
  menu.addItem(root)
  let scenarios = NSMenu()
  root.submenu = scenarios
  for (title, action, key) in [
    ("重启", #selector(PreviewActions.restart(_:)), "1"),
    ("启动失败", #selector(PreviewActions.failure(_:)), "2"),
    ("浅色", #selector(PreviewActions.light(_:)), "3"),
    ("深色", #selector(PreviewActions.dark(_:)), "4"),
    ("窄窗口", #selector(PreviewActions.small(_:)), "5"),
  ] {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.target = previewActions
    scenarios.addItem(item)
  }
  scenarios.addItem(NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
  app.mainMenu = menu
  window.center()
  window.makeKeyAndOrderFront(nil)
  app.activate(ignoringOtherApps: true)
  app.run()
  exit(0)
}

DispatchQueue.global().asyncAfter(deadline: .now() + 45) {
  fputs("FAIL: offline UI timed out\n", stderr)
  exit(1)
}
window.setFrameOrigin(NSPoint(x: -20000, y: -20000))
window.orderFrontRegardless()
let views = descendants(offline)
let logo = views.compactMap { $0 as? WKWebView }.first!
let text = views.compactMap { $0 as? NSTextField }
require(!views.contains { $0 is NSProgressIndicator }, "brand replaces generic spinner")
require(text.contains { $0.stringValue == "正在重启 Navi" }, "restart title is visible")
require(text.contains { $0.stringValue.contains("自动回到工作区") }, "automatic return is explained")

if CommandLine.arguments.contains("--fallback") {
  require(logo.isHidden, "missing SVG does not expose an empty web view")
  require(views.compactMap { $0 as? NSImageView }.contains { !$0.isHidden && $0.image != nil },
          "missing SVG keeps the app icon")
  print("PASS: missing brand resource retains native app icon")
  exit(0)
}

let deadline = Date().addingTimeInterval(15)
while logo.isHidden && Date() < deadline { spin(0.03) }
require(!logo.isHidden, "bundled brand SVG loads without a server")
offline.layoutSubtreeIfNeeded()
spin(0.2)
require(logo.bounds.width == 80 && logo.bounds.height == 80, "native logo viewport fits tile")
let restartDetail = text.first { $0.stringValue.contains("自动回到工作区") }!
require((440...444).contains(restartDetail.bounds.width),
        "detail gets readable width instead of collapsing to title width: \(restartDetail.frame)")
require(js(logo, "document.querySelectorAll('svg polygon').length") == "4", "canonical four-polygon logo")
let animationState = "getComputedStyle(document.querySelector('.navi-mark__needle')).animationPlayState"
require(js(logo, animationState) == "running", "restart animates the compass needle")
require(js(logo, "document.querySelector('svg').getBoundingClientRect().width") == "80", "SVG fits native tile")
let viewport = js(logo, "[document.body.scrollWidth,innerWidth,document.body.scrollHeight,innerHeight].join(',')")
require(viewport == "80,80,80,80", "logo has no scrollbars: \(viewport)")
offline.isHidden = true
require(js(logo, animationState) == "paused", "hidden overlay stops its animation")
offline.isHidden = false
require(js(logo, animationState) == "running", "visible busy overlay resumes animation")

var retries = 0
offline.show(title: "Navi 服务没起来", detail: "原因仍可复制。", actions: [.init(title: "重试") { retries += 1 }])
require(js(logo, animationState) == "paused", "failure retains static branding")
let retry = descendants(offline).compactMap { $0 as? NSButton }.first { $0.title == "重试" }!
require(retry.keyEquivalent == "\r", "retry remains the default keyboard action")
retry.performClick(nil)
require(retries == 1, "retry action remains functional")
require(text.contains { $0.stringValue == "原因仍可复制。" && $0.isSelectable }, "failure details stay selectable")
offline.isHidden = true
require(offline.hitTest(NSPoint(x: 10, y: 10)) == nil, "hidden overlay does not swallow clicks")
offline.show(panel: NSView())
require(js(logo, animationState) == "paused", "first-run panel stops brand animation")
offline.show(title: "正在启动 Navi", detail: "", busy: true)
require(js(logo, animationState) == "running", "returning from first-run panel resumes brand")
require(text.contains { $0.stringValue.isEmpty && $0.isHidden }, "empty detail does not leave a text row")

for appearance in [NSAppearance.Name.aqua, .darkAqua] {
  window.appearance = NSAppearance(named: appearance)
  window.displayIfNeeded()
  spin(0.5)
  let dark = appearance == .darkAqua
  let actualTheme = js(logo, "String(matchMedia('(prefers-color-scheme:dark)').matches)")
  require(actualTheme == String(dark), "SVG follows native appearance: \(appearance.rawValue) got \(actualTheme)")
  let color = dark ? "rgb(255, 107, 107)" : "rgb(229, 72, 77)"
  require(js(logo, "getComputedStyle(document.querySelector('.navi-mark__north')).fill") == color,
          "SVG uses canonical theme-aware needle color")
}
window.setContentSize(NSSize(width: 440, height: 420))
offline.layoutSubtreeIfNeeded()
for label in text where !label.isHidden {
  require(offline.bounds.contains(offline.convert(label.bounds, from: label)), "text fits narrow window")
}
print("PASS: restart, error, retry, first-run handoff, hidden lifecycle, light/dark and narrow layout")
window.close()
exit(0)
