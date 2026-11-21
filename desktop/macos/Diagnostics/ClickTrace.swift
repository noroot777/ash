import AppKit
import WebKit

#if NAVI_CLICK_TRACE_CANDIDATE
typealias TraceInputWebView = CandidateNaviWebView
#else
typealias TraceInputWebView = OriginalNaviWebView
#endif

final class NaviWebView: TraceInputWebView {
  private var trace: ClickTrace?

  override init(frame: NSRect, configuration: WKWebViewConfiguration) {
    super.init(frame: frame, configuration: configuration)
    trace = ClickTrace(webView: self)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

private final class ClickTrace: NSObject, WKScriptMessageHandler {
  private let output: FileHandle
  private let queue = DispatchQueue(label: "navi.click-trace")
  private var monitor: Any?
  private var observation: NSKeyValueObservation?
  private var lines = 0

  init?(webView: WKWebView) {
    guard let path = ProcessInfo.processInfo.environment["NAVI_MAC_CLICK_TRACE"],
          FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]),
          let output = FileHandle(forWritingAtPath: path) else { return nil }
    self.output = output
    super.init()
    webView.configuration.userContentController.add(self, name: "naviClickTrace")
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { [weak self, weak webView] event in
      guard let webView, let window = webView.window, event.window === window else { return event }
      let hit = window.contentView?.hitTest(event.locationInWindow)
      self?.record([
        "source": "native", "type": event.type == .leftMouseDown ? "mousedown" : "mouseup",
        "eventNumber": event.eventNumber, "uptime": event.timestamp,
        "active": NSApp.isActive, "keyWindow": window.isKeyWindow,
        "clickCount": event.clickCount, "x": event.locationInWindow.x, "y": event.locationInWindow.y,
        "hitView": hit.map { String(describing: type(of: $0)) } ?? "nil",
        "firstResponder": window.firstResponder.map { String(describing: type(of: $0)) } ?? "nil",
        "inputSource": NSTextInputContext.current?.selectedKeyboardInputSource ?? "nil",
      ])
      return event
    }
    observation = webView.observe(\.isLoading, options: [.new]) { [weak self, weak webView] _, _ in
      guard let webView, !webView.isLoading else { return }
      webView.evaluateJavaScript(Self.pageScript) { _, error in
        self?.record(["source": "trace", "type": "page-ready", "installed": error == nil])
      }
    }
    record(["source": "trace", "type": "started", "pid": ProcessInfo.processInfo.processIdentifier,
      "inputVariant": ProcessInfo.processInfo.environment["NAVI_MAC_CLICK_TRACE_INPUT"] ?? "installed"])
  }

  deinit {
    if let monitor { NSEvent.removeMonitor(monitor) }
  }

  private func record(_ fields: [String: Any]) {
    var entry = fields
    entry["receivedAt"] = Date().timeIntervalSince1970 * 1000
    queue.async { [self, entry] in
      guard lines < 10000, let data = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]) else { return }
      lines += 1
      try? output.write(contentsOf: data + Data([10]))
    }
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any] else { return }
    record(body)
  }

  private static let pageScript = #"""
  (() => {
    if (window.__naviClickTrace) return;
    window.__naviClickTrace = true;
    const nodes = new WeakMap();
    let serial = 0;
    let pressed = null;
    let pressing = false;
    const describe = node => {
      if (!(node instanceof Element)) return null;
      if (!nodes.has(node)) nodes.set(node, ++serial);
      return { node: nodes.get(node), tag: node.tagName, id: node.id,
        classes: String(node.className).slice(0, 250), connected: node.isConnected,
        task: node.closest('[data-task-id]')?.getAttribute('data-task-id') || null };
    };
    const route = () => {
      const query = new URLSearchParams(location.search);
      return { path: location.pathname, task: query.get('task'), view: query.get('view') };
    };
    const post = fields => window.webkit.messageHandlers.naviClickTrace.postMessage({
      source: 'page', at: Date.now(), ...fields });
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick']) {
      for (const capture of [true, false]) {
        window.addEventListener(type, event => {
          if (capture && type === 'pointerdown') { pressed = event.target; pressing = true; }
          post({ type, phase: capture ? 'capture' : 'bubble', eventTime: event.timeStamp,
            trusted: event.isTrusted, button: event.button, detail: event.detail,
            x: event.clientX, y: event.clientY, target: describe(event.target),
            focus: describe(document.activeElement), downTarget: describe(pressed),
            prevented: event.defaultPrevented, route: route() });
          if (capture && ['pointerup', 'pointercancel'].includes(type)) pressing = false;
          if (capture && type === 'click') setTimeout(() => {
            post({ type: 'click-settled', target: describe(event.target), route: route(),
              prevented: event.defaultPrevented });
          }, 50);
        }, { capture, passive: true });
      }
    }
    new MutationObserver(() => {
      if (pressing && pressed && !pressed.isConnected) {
        post({ type: 'down-target-detached', target: describe(pressed), route: route() });
        pressed = null;
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
    post({ type: 'installed', route: route() });
  })();
  """#
}
