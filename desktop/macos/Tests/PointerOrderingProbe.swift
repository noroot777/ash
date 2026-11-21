import AppKit
import WebKit

private final class DeferredMouseInputContext: NSTextInputContext {
  var asynchronous: [(NSEvent, (Bool) -> Void)] = []
  var synchronous: [NSEvent.EventType] = []
  var consumed: Set<NSEvent.EventType> = []

  override func handleEvent(_ event: NSEvent) -> Bool {
    synchronous.append(event.type)
    return consumed.contains(event.type)
  }

  @objc(handleEvent:completionHandler:)
  func deferEvent(_ event: NSEvent, completionHandler: @escaping (Bool) -> Void) {
    asynchronous.append((event, completionHandler))
  }

  func finishInReverseOrder() {
    let pending = asynchronous
    asynchronous.removeAll()
    for (_, completion) in pending.reversed() { completion(false) }
  }
}

private final class PointerProbeWebView: NaviWebView {
  lazy var deferredContext = DeferredMouseInputContext(client: self as! NSTextInputClient)
  override var inputContext: NSTextInputContext? {
    super.inputContext == nil ? nil : deferredContext
  }
}

private final class PointerProbeWindow: NSWindow {
  override var isKeyWindow: Bool { true }
  override var isMainWindow: Bool { true }
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

func runPointerOrderingProbe(_ app: NSApplication, spin: (TimeInterval) -> Void) {
  let window = PointerProbeWindow(
    contentRect: NSRect(x: 0, y: 0, width: 640, height: 320),
    styleMask: [.titled, .closable], backing: .buffered, defer: false)
  let deferredWebView = PointerProbeWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 320))
  var webView: NaviWebView = deferredWebView
  window.contentView = webView
  window.setFrameOrigin(NSPoint(x: -28000, y: -20000))
  window.orderFrontRegardless()
  window.makeKey()
  defer { window.orderOut(nil) }

  func js(_ source: String) -> String {
    var result: String?
    webView.evaluateJavaScript(source) { value, error in
      result = error.map { "ERROR: \($0)" } ?? String(describing: value ?? "nil")
    }
    let deadline = Date().addingTimeInterval(5)
    while result == nil && Date() < deadline { spin(0.01) }
    return result ?? "TIMEOUT"
  }
  func eventually(_ message: String, _ condition: () -> Bool) {
    let deadline = Date().addingTimeInterval(5)
    while !condition() && Date() < deadline { spin(0.01) }
    require(condition(), message)
  }

  let page = """
    <style>body { margin: 0 } input, button { position: absolute; height: 30px; width: 180px }
    #field { top: 20px; left: 20px } #task { top: 100px; left: 20px }
    #action { top: 100px; left: 240px }</style>
    <input id="field"><button id="task">Task</button><button id="action">Action</button>
    <script>
      window.seen = [];
      for (const type of ['mousedown', 'mouseup', 'click', 'contextmenu']) {
        document.addEventListener(type, event => {
          window.seen.push(type + ':' + event.target.id);
          if (type === 'contextmenu') event.preventDefault();
        });
      }
    </script>
    """
  webView.loadHTMLString(page, baseURL: nil)
  eventually("pointer probe page loads") { js("document.readyState") == "complete" && js("window.seen.length") == "0" }

  func focusField() {
    _ = js("document.getElementById('field').focus(); window.seen = []")
    eventually("focused editor exposes its input context") { webView.inputContext != nil }
    deferredWebView.deferredContext.synchronous.removeAll()
  }
  var eventNumber = 10000
  func mouse(_ type: NSEvent.EventType, _ x: CGFloat, _ y: CGFloat, clicks: Int = 1) {
    eventNumber += 1
    let event = NSEvent.mouseEvent(
      with: type, location: NSPoint(x: x, y: 320 - y), modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
      eventNumber: eventNumber, clickCount: clicks, pressure: type == .leftMouseUp ? 0 : 1)!
    app.sendEvent(event)
  }
  func click(_ x: CGFloat, _ y: CGFloat, clicks: Int = 1) {
    mouse(.leftMouseDown, x, y, clicks: clicks)
    mouse(.leftMouseUp, x, y, clicks: clicks)
    deferredWebView.deferredContext.finishInReverseOrder()
  }

  focusField()
  click(80, 35)
  eventually("a rapid click stays down/up/click despite reversed IME completions (\(js("window.seen.join(',')")))") {
    js("window.seen.join(',')") == "mousedown:field,mouseup:field,click:field"
  }
  require(deferredWebView.deferredContext.synchronous == [.leftMouseDown, .leftMouseUp], "the input method sees each mouse event once, in native order")
  require(deferredWebView.deferredContext.asynchronous.isEmpty, "WebKit does not asynchronously reprocess the mouse events")

  for (target, x) in [("task", CGFloat(80)), ("action", CGFloat(300))] {
    focusField()
    click(x, 115)
    eventually("the first click from an editor activates \(target) (\(js("window.seen.join(',')")))") {
      js("window.seen.join(',')") == "mousedown:\(target),mouseup:\(target),click:\(target)"
    }
  }

  focusField()
  deferredWebView.deferredContext.consumed = [.leftMouseDown]
  click(80, 35)
  eventually("an IME-consumed press never becomes a page click") { js("window.seen.join(',')") == "mouseup:field" }
  deferredWebView.deferredContext.consumed = []

  focusField()
  let context = webView.inputContext
  click(80, 35)
  click(80, 35, clicks: 2)
  eventually("double-clicks retain both native clicks") { js("window.seen.filter(event => event === 'click:field').length") == "2" }
  require(webView.inputContext === context, "the editor input context is restored after mouse dispatch")
  (webView as! NSTextInputClient).insertText("中文输入", replacementRange: NSRange(location: NSNotFound, length: 0))
  eventually("Chinese text input remains available after pointer dispatch") { js("document.getElementById('field').value") == "中文输入" }

  webView = NaviWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 320))
  window.contentView = webView
  window.makeFirstResponder(webView)
  webView.loadHTMLString(page, baseURL: nil)
  eventually("real input context probe page loads") { js("document.readyState") == "complete" && js("window.seen.length") == "0" }
  for index in 0..<20 {
    let target = index.isMultiple(of: 2) ? "task" : "action"
    let position: CGFloat = target == "task" ? 80 : 300
    focusField()
    click(position, 115)
    eventually("real input context keeps first click \(index + 1) on \(target) (\(js("window.seen.join(',')")))") {
      js("window.seen.join(',')") == "mousedown:\(target),mouseup:\(target),click:\(target)"
    }
  }
  print("PASS: focused editor, task rows and buttons keep first clicks with a delayed input method; consumed presses, double-clicks and Chinese input remain intact")
}
