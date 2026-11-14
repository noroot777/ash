import AppKit
import WebKit

/// 窗口在线之后端口换了人：页面得撤掉、盖上说明，自己那份回来再回到原路由。
///
/// 真的 BrowserWindowController（窗口不上屏），服务是测试脚本摆的假应答者。协议走 stdin/stdout：
/// 页面载好打印 `LOADED <url>`，读到一行 `FLIPPED` 后（脚本已经把端口换成别的 ash），`reload` 模式
/// 当场刷新一次 —— 定时认人调得很慢，验的是导航那一道；`watch` 模式什么都不做，验定时那一道。
/// 撤下后打印 `BLANKED …`，再读到 `BACK` 后等页面回来打印 `RESTORED <url>`，读到 `DONE` 退出。
func runInstanceGuardProbe(mode: String) -> Never {
  DispatchQueue.global().asyncAfter(deadline: .now() + 60) {
    fputs("FAIL: instance guard probe timed out\n", stderr)
    exit(1)
  }
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  app.finishLaunching()
  BrowserWindowController.instanceGuardInterval = mode == "reload" ? 3600 : 0.5

  var lines: [String] = []
  let input = NSLock()
  Thread.detachNewThread {
    while let line = readLine() {
      input.lock(); lines.append(line); input.unlock()
    }
  }
  func received(_ line: String) -> Bool {
    input.lock(); defer { input.unlock() }
    return lines.contains(line)
  }
  func spin(until done: () -> Bool, _ what: String) {
    let deadline = Date().addingTimeInterval(20)
    while !done() {
      guard Date() < deadline else {
        fputs("FAIL: waiting for \(what)\n", stderr)
        exit(1)
      }
      RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
  }
  func texts(in view: NSView) -> [String] {
    ((view as? NSTextField).map { [$0.stringValue] } ?? []) + view.subviews.flatMap(texts)
  }
  func say(_ line: String) {
    print(line)
    fflush(stdout)
  }

  let controller = BrowserWindowController()
  let webView = controller.webView
  spin(until: { webView.title == "OURS" && webView.url?.path == "/route/abc" && !webView.isLoading }, "our page")
  say("LOADED \(webView.url!.absoluteString)")
  spin(until: { received("FLIPPED") }, "the flip")
  if mode == "reload" { controller.reloadPage(nil) }
  spin(until: { !controller.offlineView.isHidden && texts(in: controller.offlineView).contains { $0.contains("端口被占着") } },
       "the occupied screen")
  spin(until: { !webView.isLoading }, "the blank page")
  var content: String?
  webView.evaluateJavaScript("document.title + '|' + document.head.innerHTML + '|' + document.body.innerHTML") { value, error in
    content = error.map { "ERROR: \($0)" } ?? String(describing: value ?? "nil")
  }
  spin(until: { content != nil }, "the page content")
  // 撤下的是整页：留下的文档里既没有原来那份的页面（它的脚本还在跑就会接着发请求），也没有新来的。
  say("BLANKED url=\(webView.url?.absoluteString ?? "nil") content=\(content!)")
  spin(until: { received("BACK") }, "our service coming back")
  spin(until: { controller.offlineView.isHidden && webView.title == "OURS" && !webView.isLoading }, "the page coming back")
  say("RESTORED \(webView.url!.absoluteString)")
  // 页面回来之后发的请求要带上新的实例号，脚本看到了再放行退出。
  spin(until: { received("DONE") }, "the script to finish")
  exit(0)
}
