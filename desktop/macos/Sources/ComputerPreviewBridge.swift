import AppKit
import WebKit

struct ComputerPreviewRequest: Equatable {
  let id: String
  let taskId: String
  let sessionId: String
  let turnStartedAt: String

  init?(_ body: [String: Any]) {
    guard let id = body["id"] as? String, let task = body["taskId"] as? String,
          let session = body["sessionId"] as? String, let turn = body["turnStartedAt"] as? String,
          [id, task, session, turn].allSatisfy({ !$0.isEmpty && $0.count <= 256 }),
          task.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return nil }
    self.id = id; taskId = task; sessionId = session; turnStartedAt = turn
  }

  func target(in data: Data) -> ComputerCaptureTarget? {
    guard let runtime = try? JSONDecoder().decode(Runtime.self, from: data), let frame = runtime.computer,
          frame.sessionId == sessionId, frame.turnStartedAt == turnStartedAt,
          let target = frame.target, !target.application.isEmpty else { return nil }
    return target
  }

  private struct Runtime: Decodable {
    let computer: Frame?
    struct Frame: Decodable {
      let sessionId: String
      let turnStartedAt: String
      let target: ComputerCaptureTarget?
    }
  }
}

@MainActor
final class ComputerPreviewBridge: NSObject, WKScriptMessageHandler {
  static let messageName = "naviComputerPreview"
  private weak var webView: WKWebView?
  private let origin: URL
  private let local: Bool
  private var request: ComputerPreviewRequest?
  private var runner: Task<Void, Never>?
  private var capture: ComputerPreviewCapturing?
  private var captureGeneration: UUID?
  private let hasPermission: () -> Bool
  private let askPermission: @MainActor () -> Void
  private let makeCapture: () -> ComputerPreviewCapturing
  private var heartbeat = Date.distantPast
  private var validated = Date.distantPast
  private var sending = false
  private let network = URLSession(configuration: .ephemeral, delegate: NoPreviewRedirect(), delegateQueue: nil)

  init(webView: WKWebView, origin: URL, local: Bool,
       hasPermission: @escaping () -> Bool = { CGPreflightScreenCaptureAccess() },
       askPermission: @escaping @MainActor () -> Void = ComputerPreviewBridge.requestPermission,
       makeCapture: @escaping () -> ComputerPreviewCapturing = { ComputerPreviewStream() }) {
    self.webView = webView; self.origin = origin; self.local = local
    self.hasPermission = hasPermission; self.askPermission = askPermission; self.makeCapture = makeCapture
    super.init()
    webView.configuration.userContentController.add(WeakComputerPreviewHandler(self), name: Self.messageName)
  }

  func stop() {
    request = nil
    runner?.cancel(); runner = nil
    capture?.stop(); capture = nil
    captureGeneration = nil
    sending = false
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, sameOrigin(message.frameInfo.request.url), sameOrigin(webView?.url),
          let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
    if !local {
      if action == "start", let id = body["id"] as? String {
        webView?.callAsyncJavaScript(Self.deliver, arguments: ["payload": ["id": id, "state": "error", "error": "远程实例不支持本机实时画面"]], in: nil, in: .page, completionHandler: nil)
      }
      return
    }
    if action == "stop", body["id"] as? String == request?.id { stop(); return }
    if action == "heartbeat", body["id"] as? String == request?.id { heartbeat = Date(); return }
    if action == "permission", body["id"] as? String == request?.id {
      askPermission()
      return
    }
    guard action == "start", let next = ComputerPreviewRequest(body) else { return }
    stop(); request = next; heartbeat = Date()
    runner = Task { [weak self] in await self?.run(next) }
  }

  private func run(_ current: ComputerPreviewRequest) async {
    var previous: ComputerCaptureTarget?
    while alive(current) {
      do {
        guard let target = try await loadTarget(current), alive(current) else {
          finish(current, state: "ended"); return
        }
        validated = Date()
        if !hasPermission() {
          capture?.stop(); capture = nil; captureGeneration = nil
          publish(current, ["state": "permission", "error": "允许 Navi 录制屏幕后，才能连续显示操作画面"])
        } else if target != previous || capture == nil {
          capture?.stop()
          let stream = makeCapture()
          let generation = UUID()
          captureGeneration = generation
          capture = stream; previous = target
          stream.onFrame = { [weak self] data in
            DispatchQueue.main.async {
              if self?.captureGeneration == generation { self?.publishFrame(current, data: data) }
            }
          }
          stream.onFailure = { [weak self] message in
            DispatchQueue.main.async {
              if self?.captureGeneration == generation { self?.finish(current, state: "error", error: message) }
            }
          }
          try await stream.start(target)
          guard alive(current) else { stream.stop(); return }
        }
      } catch {
        finish(current, state: "error", error: error.localizedDescription); return
      }
      try? await Task.sleep(nanoseconds: 1_000_000_000)
    }
    if request?.id == current.id { finish(current, state: "ended") }
  }

  private func alive(_ current: ComputerPreviewRequest) -> Bool {
    request?.id == current.id && !Task.isCancelled && Date().timeIntervalSince(heartbeat) < 4 && sameOrigin(webView?.url)
  }

  private func loadTarget(_ current: ComputerPreviewRequest) async throws -> ComputerCaptureTarget? {
    guard let webView else { return nil }
    let cookies = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
    guard alive(current) else { return nil }
    var call = URLRequest(url: origin.appendingPathComponent("api/tasks/\(current.taskId)/runtime"), timeoutInterval: 2)
    call.cachePolicy = .reloadIgnoringLocalCacheData
    let matching = cookies.filter { $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == origin.host
      && (!$0.isSecure || origin.scheme == "https") }
    call.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: matching)
    let (data, response) = try await network.data(for: call)
    guard let response = response as? HTTPURLResponse, response.statusCode == 200, sameOrigin(response.url) else {
      throw NSError(domain: "NaviComputerPreview", code: 2, userInfo: [NSLocalizedDescriptionKey: "实时画面连接已失效，请重新连接"])
    }
    return current.target(in: data)
  }

  private func publishFrame(_ current: ComputerPreviewRequest, data: Data) {
    guard alive(current), Date().timeIntervalSince(validated) < 3, !sending, let webView else { return }
    sending = true
    let payload: [String: Any] = ["id": current.id, "state": "frame", "image": "data:image/jpeg;base64,\(data.base64EncodedString())"]
    webView.callAsyncJavaScript(Self.deliver, arguments: ["payload": payload], in: nil, in: .page) { [weak self] _ in
      if self?.request?.id == current.id { self?.sending = false }
    }
  }

  private func publish(_ current: ComputerPreviewRequest, _ value: [String: Any]) {
    guard request?.id == current.id, sameOrigin(webView?.url) else { return }
    var payload = value; payload["id"] = current.id
    webView?.callAsyncJavaScript(Self.deliver, arguments: ["payload": payload], in: nil, in: .page, completionHandler: nil)
  }

  private func finish(_ current: ComputerPreviewRequest, state: String, error: String = "") {
    guard request?.id == current.id else { return }
    publish(current, ["state": state, "error": error])
    stop()
  }

  private func sameOrigin(_ url: URL?) -> Bool {
    guard let url else { return false }
    return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
  }

  private static let deliver = "window.dispatchEvent(new CustomEvent('navi:computer-preview', {detail: payload}));"
  private static func requestPermission() {
    if !CGPreflightScreenCaptureAccess(), !CGRequestScreenCaptureAccess(),
       let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
      NSWorkspace.shared.open(url)
    }
  }
}

private final class WeakComputerPreviewHandler: NSObject, WKScriptMessageHandler {
  private weak var target: ComputerPreviewBridge?
  init(_ target: ComputerPreviewBridge) { self.target = target }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(controller, didReceive: message)
  }
}

private final class NoPreviewRedirect: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
