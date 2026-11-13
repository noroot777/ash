import AppKit
import WebKit

/// 唯一的主窗口：一个铺满的 WKWebView 加一层「连不上」时的原生占位。
final class BrowserWindowController: NSWindowController, NSWindowDelegate, NSMenuItemValidation {
  let webView: WKWebView
  let offlineView = OfflineView()
  var downloads: [ObjectIdentifier: DownloadTransaction] = [:]
  private var chrome: WindowChrome?
  private var observations: [NSKeyValueObservation] = []
  private var healthTimer: Timer?
  /// 「正在启动」那一屏晚一点才盖上：服务本来就在时探一下只要几毫秒，不该闪一下。
  var pendingStartingScreen: DispatchWorkItem?

  init() {
    let config = WKWebViewConfiguration()
    // 默认数据仓：cookie（多人模式的 ash_session）、localStorage（主题、草稿）跨启动保留。
    config.websiteDataStore = .default()
    // 服务端和前端日后要按壳区分行为时有个抓手，不影响现有判断。
    config.applicationNameForUserAgent = "Version/26.0 Safari/605.1.15 AshMac/\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0")"
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
    window.tabbingMode = .disallowed
    super.init(window: window)

    window.delegate = self
    window.contentView = makeContent()
    // 内容铺到窗口顶，红绿灯浮在页面上（见 WindowChrome）。窗口底色仍跟页面的 theme-color 走，
    // 页面还没画出来的那一瞬和占位页都是同一个底色。
    chrome = WindowChrome(window: window, webView: webView)
    // 位置和大小记在 UserDefaults 里，下次原样打开。
    window.setFrameAutosaveName("AshMainWindow")
    if !window.setFrameUsingName("AshMainWindow") { window.center() }

    webView.navigationDelegate = self
    webView.uiDelegate = self
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

  // 进全屏在动画开始前就让页面收回留白，出全屏等红绿灯回来再让出来。
  func windowWillEnterFullScreen(_ notification: Notification) { chrome?.setFullScreen(true) }
  func windowDidFailToEnterFullScreen(_ window: NSWindow) { chrome?.setFullScreen(false) }
  func windowDidExitFullScreen(_ notification: Notification) { chrome?.setFullScreen(false) }

  /// 把页面直接载进来（端口上是谁已经认过了，或者连的本来就是别处的 ash）。
  func loadPage() {
    stopHealthPolling()
    offlineView.isHidden = true
    // 失败页之后 webView.url 可能是 nil，此时回首页；正常情况下原地重载保住当前路由。
    if let url = webView.url, AshConfig.isSameOrigin(url) {
      webView.load(URLRequest(url: url))
    } else {
      webView.load(URLRequest(url: AshConfig.baseURL))
    }
  }

  /// 后台每 2 秒探一次 /api/health，自己那份通了就载回去 —— 服务也可能是别处（登录项、
  /// 另一个窗口的重试）起好的，占着端口的那份也可能被用户停掉了。
  ///
  /// `takeOverWhenFree`：端口被别人占着时，对方一停（端口空出来）就接着起自己那份，不必用户再点
  /// 「重试」。只给「被占着」这一档：起不来的那一档要是也这样，就会每 2 秒起一次注定失败的服务。
  func startHealthPolling(takeOverWhenFree: Bool = false) {
    guard healthTimer == nil else { return }
    healthTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      AshHealth.probe { probe in
        var down = false
        if case .down = probe { down = true }
        guard AshHealth.isServing(probe) || (takeOverWhenFree && down) else { return }
        DispatchQueue.main.async { self?.loadHome() }
      }
    }
  }

  func stopHealthPolling() {
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
