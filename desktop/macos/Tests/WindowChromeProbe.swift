import AppKit
import WebKit

/// 记下窗口被要求做了什么，不真的去拖、去缩放。
///
/// 自称是当前窗口、ProbeApplication 自称在前台：探针不能真去抢用户的焦点，而 AppKit 对后台应用
/// 的窗口会把第一下点击当成「激活」吃掉，事件到不了页面。
private final class ProbeWindow: NSWindow {
  var drags = 0
  var titlebarDoubleClicks = 0
  override var isKeyWindow: Bool { true }
  override var isMainWindow: Bool { true }
  override func performDrag(with event: NSEvent) { drags += 1 }
  override func zoom(_ sender: Any?) { titlebarDoubleClicks += 1 }
  override func miniaturize(_ sender: Any?) { titlebarDoubleClicks += 1 }
  // 带标题栏的窗口在 orderFront 时会被 AppKit 拉回屏幕内（摆在屏幕外的探针曾因此停在主屏左下角）。
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

private final class ProbeApplication: NSApplication {
  override var isActive: Bool { true }
}

/// 红绿灯浮在页面上之后，标题栏那一条的鼠标事件还走不走得通。
///
/// 事件是合成的，但走的是 `NSApp.sendEvent` 这条真分发路径：窗口框架先做命中测试，再交给
/// WKWebView，再进页面脚本，再经消息回到 WindowChrome。任何一环把事件吞了都会在这里露出来
/// （占位层吞掉整窗点击那一回就是这一类）。
func runWindowChromeProbe() -> Never {
  // 事件要是被哪一层吞进了自己的跟踪循环，下面的等待永远回不来；到点直接判失败。
  DispatchQueue.global().asyncAfter(deadline: .now() + 60) {
    fputs("FAIL: window chrome probe timed out\n", stderr)
    exit(1)
  }
  let app = ProbeApplication.shared
  app.setActivationPolicy(.accessory)
  app.finishLaunching()

  let window = ProbeWindow(
    contentRect: NSRect(x: 0, y: 0, width: 640, height: 320),
    styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
  let webView = WKWebView(frame: window.contentLayoutRect)
  webView.autoresizingMask = [.width, .height]
  window.contentView = webView
  let chrome = WindowChrome(window: window, webView: webView)
  chrome.isPrimaryButtonDown = { true }
  webView.frame = window.contentView!.bounds
  // 窗口摆在屏幕外、在本应用内设为当前窗口，不激活应用：用户看不到它，键盘焦点也还在他正用的应用上。
  window.setFrameOrigin(NSPoint(x: -20000, y: -20000))
  window.orderFrontRegardless()
  window.makeKey()
  require(!NSScreen.screens.contains { $0.frame.intersects(window.frame) }, "probe window stays off every screen (\(window.frame))")

  func spin(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
  func js(_ source: String) -> String {
    var result: String?
    webView.evaluateJavaScript(source) { value, error in
      result = error.map { "ERROR: \($0)" } ?? String(describing: value ?? "nil")
    }
    let deadline = Date().addingTimeInterval(10)
    while result == nil && Date() < deadline { spin(0.01) }
    return result ?? "TIMEOUT"
  }
  func eventually(_ message: String, _ condition: () -> Bool) {
    let deadline = Date().addingTimeInterval(5)
    while !condition() && Date() < deadline { spin(0.02) }
    require(condition(), message)
  }
  var eventNumber = 0
  func mouse(_ type: NSEvent.EventType, _ x: CGFloat, _ fromTop: CGFloat, clicks: Int = 1) {
    eventNumber += 1
    let event = NSEvent.mouseEvent(
      with: type, location: NSPoint(x: x, y: window.frame.height - fromTop), modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
      eventNumber: eventNumber, clickCount: clicks, pressure: type == .leftMouseUp ? 0 : 1)!
    app.sendEvent(event)
    spin(0.05)
  }
  func click(_ x: CGFloat, _ fromTop: CGFloat, clicks: Int = 1) {
    mouse(.leftMouseDown, x, fromTop, clicks: clicks)
    mouse(.leftMouseUp, x, fromTop, clicks: clicks)
  }
  func drag(_ x: CGFloat, _ fromTop: CGFloat) {
    mouse(.leftMouseDown, x, fromTop)
    mouse(.leftMouseDragged, x + 12, fromTop + 2)
    mouse(.leftMouseDragged, x + 24, fromTop + 4)
    spin(0.3)
    mouse(.leftMouseUp, x + 24, fromTop + 4)
  }
  func log() -> String { js("window.seen.join(',')") }
  func forget() { _ = js("window.seen = []") }

  // #strip-button 在红绿灯那一条里；#bar 在它下面、用 --window-drag 划成可拖；#plain 什么都不是。
  let page = """
    <meta name="ash-window-chrome" content="overlay">
    <style>
      html, body { margin: 0; height: 100%; }
      button { position: fixed; width: 80px; height: 18px; padding: 0; }
      #strip-button { left: 200px; top: 4px; }
      #bar { position: fixed; left: 0; right: 0; top: 80px; height: 40px; --window-drag: drag; }
      #bar-button { left: 200px; top: 91px; }
      #bar-handle { position: absolute; left: 400px; top: 0; width: 20px; height: 40px; cursor: col-resize; }
      #plain { position: fixed; left: 0; right: 0; top: 160px; height: 40px; }
    </style>
    <button id="strip-button">strip</button>
    <div id="bar"><button id="bar-button">bar</button><div id="bar-handle"></div></div>
    <div id="plain"></div>
    <input id="field" style="position: fixed; left: 20px; top: 220px;">
    <script>
      window.seen = [];
      document.addEventListener("click", (event) => window.seen.push("click:" + (event.target.id || event.target.localName)));
    </script>
    """
  webView.loadHTMLString(page, baseURL: nil)
  eventually("probe page loads") { js("document.readyState") == "complete" && log() == "" }

  require(js("document.documentElement.dataset.windowShell") == "mac", "page is told it lives in the mac shell")
  let titlebar = Double(js("parseFloat(document.documentElement.style.getPropertyValue('--window-titlebar-height'))")) ?? 0
  let controls = Double(js("parseFloat(document.documentElement.style.getPropertyValue('--window-controls-width'))")) ?? 0
  require(titlebar >= 20 && titlebar <= 60, "titlebar height is measured from the real window (\(titlebar))")
  require(controls >= 50 && controls <= 120, "window controls width is measured from the real buttons (\(controls))")
  require(webView.frame.maxY == window.frame.height, "page reaches the top edge of the window")

  let stripPoint = NSPoint(x: 240, y: window.frame.height - 13)
  require(window.contentView?.superview?.hitTest(stripPoint) === webView, "the title bar does not claim points over the page")

  click(240, 13)
  eventually("a button under the window controls strip still receives clicks (\(log()))") { log() == "click:strip-button" }
  require(window.drags == 0, "clicking a button in the strip does not drag the window")

  forget()
  click(500, 13)
  eventually("a plain click on the empty strip stays a click for the page (\(log()))") { ["click:html", "click:body"].contains(log()) }
  require(window.drags == 0, "a click without movement does not drag the window")

  _ = js("document.getElementById('field').focus()")
  require(js("document.activeElement.id") == "field", "probe input takes focus")
  click(500, 13)
  eventually("clicking the empty strip still blurs the field being edited") { js("document.activeElement.localName") == "body" }

  drag(500, 13)
  eventually("dragging the empty strip drags the window") { window.drags == 1 }

  drag(520, 100)
  eventually("dragging a region the page marked --window-drag drags the window") { window.drags == 2 }

  drag(240, 100)
  drag(410, 100)
  drag(500, 180)
  spin(0.3)
  require(window.drags == 2, "buttons, resize handles and unmarked areas never drag the window (\(window.drags))")

  chrome.isPrimaryButtonDown = { false }
  drag(500, 13)
  spin(0.3)
  require(window.drags == 2, "no drag starts once the button has been released")
  chrome.isPrimaryButtonDown = { true }

  click(500, 13)
  click(500, 13, clicks: 2)
  let expected = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") == "None" ? 0 : 1
  eventually("double-clicking the strip follows the system title bar setting") { window.titlebarDoubleClicks == expected }
  click(240, 13)
  click(240, 13, clicks: 2)
  spin(0.3)
  require(window.titlebarDoubleClicks == expected, "double-clicking a button is not a title bar double-click")

  func titlebarNow() -> Double { Double(js("parseFloat(document.documentElement.style.getPropertyValue('--window-titlebar-height'))")) ?? -1 }
  chrome.setFullScreen(true)
  eventually("full screen hands the strip back to the page") {
    titlebarNow() == 0 && js("document.documentElement.style.getPropertyValue('--window-controls-width')") == "0px"
  }
  chrome.setFullScreen(false)
  eventually("leaving full screen reserves the strip again") { titlebarNow() == titlebar }
  webView.pageZoom = 2
  eventually("page zoom rescales the reserved strip into CSS pixels") { titlebarNow() == (titlebar / 2).rounded(.up) }
  webView.pageZoom = 1
  _ = js("document.title = 'stale'")
  webView.loadHTMLString(page, baseURL: nil)
  eventually("a freshly loaded document starts with the current measurements") {
    js("document.title") == "" && js("document.readyState") == "complete" && titlebarNow() == titlebar
  }

  // 不认这套约定的文档：退回普通标题栏，页面不再压在红绿灯下面；回到认的文档再铺上去。
  webView.loadHTMLString("<title>plain</title><p>no opt-in</p>", baseURL: nil)
  eventually("a document that never opted in gets the ordinary title bar back") {
    !chrome.overlay && !window.styleMask.contains(.fullSizeContentView) && window.titleVisibility == .visible
      && js("document.title") == "plain" && titlebarNow() == 0
  }
  require(window.contentView!.frame.maxY < window.frame.height, "the page no longer extends under the window controls")
  webView.loadHTMLString("<meta name='ash-window-chrome' content='overlay'><title>opted</title>", baseURL: nil)
  eventually("a document that opts in is laid out under the window controls again") {
    chrome.overlay && window.styleMask.contains(.fullSizeContentView) && js("document.title") == "opted" && titlebarNow() == titlebar
  }

  print("PASS: window chrome")
  exit(0)
}
