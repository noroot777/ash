import AppKit
import WebKit

/// 唯一的主窗口：一个铺满的 WKWebView 加一层「连不上」时的原生占位。
final class BrowserWindowController: NSWindowController, NSWindowDelegate, NSMenuItemValidation {
  let webView: WKWebView
  let offlineView = OfflineView()
  var downloads: [ObjectIdentifier: DownloadTransaction] = [:]
  private var observations: [NSKeyValueObservation] = []
  private var healthTimer: Timer?

  init() {
    let config = WKWebViewConfiguration()
    // 默认数据仓：cookie（多人模式的 ash_session）、localStorage（主题、草稿）跨启动保留。
    config.websiteDataStore = .default()
    // 服务端和前端日后要按壳区分行为时有个抓手，不影响现有判断。
    config.applicationNameForUserAgent = "Version/26.0 Safari/605.1.15 AshMac/0.1"
    config.preferences.isElementFullscreenEnabled = true

    webView = WKWebView(frame: .zero, configuration: config)
    webView.allowsBackForwardNavigationGestures = true
    webView.allowsMagnification = true
    // 出问题时 Safari「开发」菜单里能直接挂上检查器。
    webView.isInspectable = true

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "ash"
    window.minSize = NSSize(width: 720, height: 480)
    window.isReleasedWhenClosed = false
    // 标题栏透明 + 窗口底色跟页面的 theme-color 走，标题栏与页面顶栏连成一片，浅深色都对得上。
    window.titlebarAppearsTransparent = true
    window.tabbingMode = .disallowed
    super.init(window: window)

    window.delegate = self
    window.contentView = makeContent()
    // 位置和大小记在 UserDefaults 里，下次原样打开。
    window.setFrameAutosaveName("AshMainWindow")
    if !window.setFrameUsingName("AshMainWindow") { window.center() }

    webView.navigationDelegate = self
    webView.uiDelegate = self
    offlineView.onRetry = { [weak self] in self?.loadHome() }
    observe()
    loadHome()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  private func makeContent() -> NSView {
    let container = NSView()
    for view in [webView, offlineView] as [NSView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      container.addSubview(view)
      NSLayoutConstraint.activate([
        view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
        view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        view.topAnchor.constraint(equalTo: container.topAnchor),
        view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      ])
    }
    offlineView.isHidden = true
    return container
  }

  private func observe() {
    observations = [
      webView.observe(\.title, options: [.initial, .new]) { [weak self] view, _ in
        let title = view.title ?? ""
        self?.window?.title = title.isEmpty ? "ash" : title
      },
      webView.observe(\.themeColor, options: [.initial, .new]) { [weak self] view, _ in
        self?.window?.backgroundColor = view.themeColor ?? .windowBackgroundColor
      },
    ]
  }

  func loadHome() {
    stopHealthPolling()
    offlineView.isHidden = true
    // 失败页之后 webView.url 可能是 nil，此时回首页；正常情况下原地重载保住当前路由。
    if let url = webView.url, AshConfig.isSameOrigin(url) {
      webView.load(URLRequest(url: url))
    } else {
      webView.load(URLRequest(url: AshConfig.baseURL))
    }
  }

  // MARK: 连不上服务

  /// 连不上：本机地址就先替用户把服务起起来（见 ServerLauncher），起不来再说明原因。
  /// 同时每 2 秒探一次 /api/health —— 服务也可能是别处（比如 `npm run restart`）起好的。
  func showOffline(_ error: Error) {
    let address = AshConfig.baseURL.absoluteString
    let launcher = ServerLauncher.shared
    if launcher.canLaunch {
      offlineView.show(title: "正在启动 ash 服务…", detail: address, busy: true)
      launcher.ensureRunning { [weak self] outcome in
        guard let self, !self.offlineView.isHidden else { return }
        switch outcome {
        case .ready:
          self.loadHome()
        case .failed(let reason):
          self.offlineView.show(title: "ash 服务没起来", detail: reason, busy: false, log: launcher.logURL)
        }
      }
    } else {
      offlineView.show(title: "连不上 \(address)", detail: "\(error.localizedDescription)\n服务起来后会自动载入。", busy: false)
    }
    guard healthTimer == nil else { return }
    healthTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      self?.probeHealth()
    }
  }

  private func probeHealth() {
    var request = URLRequest(url: AshConfig.healthURL, timeoutInterval: 1.5)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
      guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
      DispatchQueue.main.async { self?.loadHome() }
    }.resume()
  }

  private func stopHealthPolling() {
    healthTimer?.invalidate()
    healthTimer = nil
  }

  // MARK: 菜单动作

  @objc func reloadPage(_ sender: Any?) {
    if offlineView.isHidden { webView.reload() } else { loadHome() }
  }

  @objc func openInBrowser(_ sender: Any?) {
    NSWorkspace.shared.open(webView.url ?? AshConfig.baseURL)
  }

  @objc func goBack(_ sender: Any?) { webView.goBack() }
  @objc func goForward(_ sender: Any?) { webView.goForward() }

  @objc func resetZoom(_ sender: Any?) { webView.pageZoom = 1 }
  @objc func zoomIn(_ sender: Any?) { webView.pageZoom = min(webView.pageZoom + 0.1, 3) }
  @objc func zoomOut(_ sender: Any?) { webView.pageZoom = max(webView.pageZoom - 0.1, 0.5) }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    switch item.action {
    case #selector(goBack(_:)): return webView.canGoBack
    case #selector(goForward(_:)): return webView.canGoForward
    default: return true
    }
  }
}
