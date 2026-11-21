import AppKit
import WebKit

private func require(_ condition: Bool, _ message: String) {
  if !condition { fputs("FAIL: \(message)\n", stderr); exit(1) }
}

@MainActor
private func until(_ condition: () -> Bool, timeout: TimeInterval = 8) {
  let end = Date().addingTimeInterval(timeout)
  while !condition(), Date() < end { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
  require(condition(), "timed out")
}

@MainActor
private func javascript(_ view: WKWebView, _ source: String) -> Any? {
  var done = false
  var value: Any?
  var failure: Error?
  let encoded = String(data: try! JSONSerialization.data(withJSONObject: [source]), encoding: .utf8)!
  let script = "(() => { const value = (0,eval)(\(encoded)[0]); return value == null ? null : JSON.parse(JSON.stringify(value)); })()"
  view.evaluateJavaScript(script) { result, error in value = result; failure = error; done = true }
  until { done }
  require(failure == nil, "JavaScript failed: \(String(describing: failure)), source=\(source)")
  return value
}

private final class SyntheticCapture: NSObject, ComputerPreviewCapturing {
  var onFrame: ((Data) -> Void)?
  var onFailure: ((String) -> Void)?
  var stopped = false
  var target: ComputerCaptureTarget?
  private var timer: Timer?
  private var tick = 0

  @MainActor
  func start(_ target: ComputerCaptureTarget) async throws {
    self.target = target
    scheduleFrames()
  }

  @MainActor private func scheduleFrames() {
    timer = Timer.scheduledTimer(timeInterval: 0.06, target: self, selector: #selector(emit), userInfo: nil, repeats: true)
  }

  @objc private func emit() { tick += 1; onFrame?(Data("synthetic-frame-\(tick)".utf8)) }

  func stop() { stopped = true; timer?.invalidate(); timer = nil }
}

@MainActor
private func run() {
  let origin = URL(string: CommandLine.arguments[1])!
  let application = NSApplication.shared
  application.setActivationPolicy(.accessory)
  application.finishLaunching()
  let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 640, height: 480),
                        styleMask: [.borderless], backing: .buffered, defer: false)
  let configuration = WKWebViewConfiguration()
  configuration.websiteDataStore = .nonPersistent()
  let view = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
  window.isReleasedWhenClosed = false
  window.contentView = view
  var allowed = false
  var streams: [SyntheticCapture] = []
  let bridge = ComputerPreviewBridge(webView: view, origin: origin, local: true, hasPermission: { allowed },
    askPermission: { allowed = true }, makeCapture: {
      let stream = SyntheticCapture(); streams.append(stream); return stream
    })
  let cookie = HTTPCookie(properties: [.domain: "127.0.0.1", .path: "/", .name: "preview_probe", .value: "known-instance"])!
  var cookieReady = false
  view.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { cookieReady = true }
  until { cookieReady }
  view.load(URLRequest(url: origin))
  until { !view.isLoading && view.url == origin }
  _ = javascript(view, "window.framesSeen=[]; window.states=[]; window.addEventListener('navi:computer-preview', event => {states.push(event.detail.state); if(event.detail.image)framesSeen.push(event.detail.image)});")
  let payload = "{id:'first',taskId:'task',sessionId:'session',turnStartedAt:'turn'}"
  _ = javascript(view, "window.webkit.messageHandlers.naviComputerPreview.postMessage({...\(payload),action:'start'});window.beat=setInterval(()=>window.webkit.messageHandlers.naviComputerPreview.postMessage({id:'first',action:'heartbeat'}),500)")
  until { (javascript(view, "states.includes('permission')") as? Bool) == true }
  require(streams.isEmpty, "no capture before permission")
  _ = javascript(view, "window.webkit.messageHandlers.naviComputerPreview.postMessage({id:'first',action:'permission'})")
  until { (javascript(view, "framesSeen.length") as? Int ?? 0) >= 4 }
  require(streams.count == 1, "one stream per target")
  require(streams[0].target?.application == "com.apple.Notes", "target comes from authenticated server state")
  require((javascript(view, "new Set(framesSeen).size") as? Int ?? 0) >= 3, "successive native frames reach the page")
  var ended = false
  URLSession.shared.dataTask(with: origin.appendingPathComponent("end")) { _, _, _ in DispatchQueue.main.async { ended = true } }.resume()
  until { ended && streams[0].stopped }
  until { (javascript(view, "states.includes('ended')") as? Bool) == true }
  let count = javascript(view, "framesSeen.length") as? Int
  RunLoop.current.run(until: Date().addingTimeInterval(0.2))
  require(javascript(view, "framesSeen.length") as? Int == count, "ended turn stops frames")
  _ = javascript(view, "clearInterval(window.beat); window.webkit.messageHandlers.naviComputerPreview.postMessage({...\(payload),id:'stale',action:'start'})")
  until { (javascript(view, "states.filter(state=>state==='ended').length") as? Int ?? 0) >= 2 }
  require(streams.count == 1, "stale turn cannot create a stream")
  var resumed = false
  URLSession.shared.dataTask(with: origin.appendingPathComponent("resume")) { _, _, _ in DispatchQueue.main.async { resumed = true } }.resume()
  until { resumed }
  _ = javascript(view, "const child=document.createElement('iframe'); child.src='/iframe'; document.body.append(child)")
  RunLoop.current.run(until: Date().addingTimeInterval(0.3))
  require(streams.count == 1, "iframe cannot start capture")
  _ = javascript(view, "window.webkit.messageHandlers.naviComputerPreview.postMessage({...\(payload),id:'silent',action:'start'})")
  until { streams.count == 2 }
  until { streams[1].stopped }
  require(!allowed || streams[1].stopped, "lost page heartbeat stops capture even while the turn remains active")
  bridge.stop()
  view.loadHTMLString("", baseURL: nil)
  window.close()
  print("PASS native computer preview: permission gate, cookie-bound active-turn authorization, continuous synthetic frame transport and automatic stop")
  print(CGPreflightScreenCaptureAccess() ? "ScreenCaptureKit permission available (desktop capture not requested by regression)" : "ScreenCaptureKit real capture NOT exercised: screen-recording permission is absent")
  exit(0)
}

MainActor.assumeIsolated { run() }
