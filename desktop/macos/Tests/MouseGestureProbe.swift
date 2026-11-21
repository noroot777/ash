import AppKit
import WebKit

private final class GestureInputContext: NSTextInputContext {
  var pending: [(NSEvent.EventType, (Bool) -> Void)] = []
  var synchronous: [NSEvent.EventType] = []
  var consumed: Set<NSEvent.EventType> = []

  override func handleEvent(_ event: NSEvent) -> Bool {
    synchronous.append(event.type)
    return consumed.contains(event.type)
  }

  @objc(handleEvent:completionHandler:)
  func deferEvent(_ event: NSEvent, completionHandler: @escaping (Bool) -> Void) {
    pending.append((event.type, completionHandler))
  }

  func finishBackwards() {
    let callbacks = pending
    pending.removeAll()
    callbacks.reversed().forEach { $0.1(false) }
  }
}

private final class GestureProbeWebView: NaviWebView {
  lazy var deferred = GestureInputContext(client: self as! NSTextInputClient)
  override var inputContext: NSTextInputContext? { super.inputContext == nil ? nil : deferred }
}

private final class UnorderedGestureWebView: WKWebView {
  lazy var deferred = GestureInputContext(client: self as! NSTextInputClient)
  override var inputContext: NSTextInputContext? { super.inputContext == nil ? nil : deferred }
}

private final class GestureProbeWindow: NSWindow {
  override var isKeyWindow: Bool { true }
  override var isMainWindow: Bool { true }
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

func runMouseGestureProbe(_ app: NSApplication, spin: (TimeInterval) -> Void) {
  let window = GestureProbeWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 320),
    styleMask: [.titled, .closable], backing: .buffered, defer: false)
  window.setFrameOrigin(NSPoint(x: -28000, y: -20000))
  defer { window.orderOut(nil) }
  let baseline = UnorderedGestureWebView(frame: window.contentLayoutRect)
  let candidate = GestureProbeWebView(frame: window.contentLayoutRect)
  var webView: WKWebView = baseline

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
  func load(_ view: WKWebView) {
    webView = view
    window.contentView = view
    view.frame = NSRect(x: 0, y: 0, width: 640, height: 320)
    window.orderFrontRegardless()
    window.makeKey()
    window.makeFirstResponder(view)
    view.loadHTMLString("""
      <style>body{margin:0}input,button{position:absolute;top:100px;width:150px;height:32px}
      #field{top:20px;left:20px}#agent{left:20px}#worktree{left:220px}#task{left:420px}</style>
      <input id="field"><button id="agent">agent</button><button id="worktree">worktree</button><button id="task">task</button>
      <script>window.seen=[];for(const type of ['mousedown','mouseup','click'])
      document.addEventListener(type,event=>seen.push(type+':'+event.target.id));</script>
      """, baseURL: nil)
    eventually("gesture page loaded") { js("document.readyState") == "complete" }
  }
  func focus() {
    _ = js("document.activeElement.blur();document.getElementById('field').focus();seen=[]")
    eventually("editable input context exists") { webView.inputContext != nil }
  }
  func event(_ type: NSEvent.EventType, x: CGFloat = 60, number: Int = -16383, clicks: Int = 1) -> NSEvent {
    NSEvent.mouseEvent(with: type, location: NSPoint(x: x, y: 320 - 115), modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
      eventNumber: number, clickCount: clicks, pressure: type == .leftMouseUp ? 0 : 1)!
  }
  func click(x: CGFloat, number: Int) {
    app.sendEvent(event(.leftMouseDown, x: x, number: number))
    app.sendEvent(event(.leftMouseUp, x: x, number: number))
  }

  load(baseline)
  focus()
  click(x: 60, number: -16383)
  require(baseline.deferred.pending.map { $0.0 } == [.leftMouseDown, .leftMouseUp],
    "baseline defers both gesture events: \(baseline.deferred.pending.map { $0.0 }), page=\(js("seen.join(',')"))")
  baseline.deferred.finishBackwards()
  eventually("baseline reproduces the captured up-before-down signature") {
    js("seen.join(',')") == "mouseup:agent,mousedown:agent"
  }

  load(candidate)
  for round in 0..<12 {
    focus()
    candidate.deferred.synchronous.removeAll()
    let target = ["agent", "worktree", "task"][round % 3]
    click(x: CGFloat(60 + 200 * (round % 3)), number: -16382 + round)
    require(candidate.deferred.pending.isEmpty, "button gestures do not enter asynchronous input handling")
    require(candidate.deferred.synchronous == [.leftMouseDown, .leftMouseUp], "input method receives each gesture event once")
    eventually("first click reaches \(target)") {
      js("seen.join(',')") == "mousedown:\(target),mouseup:\(target),click:\(target)"
    }
  }

  focus()
  let buttonEvents: [NSEvent.EventType] = [.leftMouseDown, .leftMouseDragged, .leftMouseUp,
    .rightMouseDown, .rightMouseDragged, .rightMouseUp, .otherMouseDown, .otherMouseDragged, .otherMouseUp]
  candidate.deferred.consumed = Set(buttonEvents)
  candidate.deferred.synchronous.removeAll()
  for type in buttonEvents {
    let gesture = event(type)
    switch type {
    case .leftMouseDown: candidate.mouseDown(with: gesture)
    case .leftMouseDragged: candidate.mouseDragged(with: gesture)
    case .leftMouseUp: candidate.mouseUp(with: gesture)
    case .rightMouseDown: candidate.rightMouseDown(with: gesture)
    case .rightMouseDragged: candidate.rightMouseDragged(with: gesture)
    case .rightMouseUp: candidate.rightMouseUp(with: gesture)
    case .otherMouseDown: candidate.otherMouseDown(with: gesture)
    case .otherMouseDragged: candidate.otherMouseDragged(with: gesture)
    case .otherMouseUp: candidate.otherMouseUp(with: gesture)
    default: break
    }
  }
  require(candidate.deferred.synchronous == buttonEvents, "all mouse buttons and drags respect consumed input")
  require(candidate.deferred.pending.isEmpty, "consumed button events are not forwarded to WebKit")
  require(js("seen.join(',')") == "", "input-method-consumed gestures do not reach the page")
  candidate.deferred.consumed.removeAll()
  candidate.deferred.synchronous.removeAll()
  candidate.mouseMoved(with: event(.mouseMoved))
  for type in [NSEvent.EventType.mouseEntered, .mouseExited] {
    let hover = NSEvent.enterExitEvent(with: type, location: NSPoint(x: 60, y: 205), modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
      eventNumber: -16001, trackingNumber: 0, userData: nil)!
    if type == .mouseEntered { candidate.mouseEntered(with: hover) } else { candidate.mouseExited(with: hover) }
  }
  require(candidate.deferred.synchronous.isEmpty, "hover events retain WebKit's input path")
  candidate.deferred.finishBackwards()
  focus()
  require(candidate.inputContext === candidate.deferred, "text input context is restored after forwarding")
  let client = candidate as! NSTextInputClient
  client.insertText("typed", replacementRange: NSRange(location: NSNotFound, length: 0))
  eventually("text input client still inserts text") { js("document.getElementById('field').value") == "typed" }
  _ = js("document.activeElement.blur();seen=[]")
  eventually("noneditable context is nil") { candidate.inputContext == nil }
  click(x: 60, number: -16000)
  eventually("no-input-context path still clicks") { js("seen.join(',')").contains("click:agent") }
}
