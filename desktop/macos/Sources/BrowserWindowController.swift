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
  private var guardTimer: Timer?
  private var guardProbing = false
  /// 页面因为端口换了人被撤下时停在哪个路由，自己那份回来后回到那里。
  private var resumeURL: URL?
  /// 页面现在认的是哪一份服务（它的实例号已经作为 cookie 交给页面）。
  private(set) var boundInstance: String?
  /// 页面在的时候多久认一次人。测试把它调大，单独验导航那一道。
  static var instanceGuardInterval: TimeInterval = 1
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

  /// 把页面载进来。连别处的 ash 时直接载；本机地址先认一次人、把那一份的实例号交给页面再载。
  func loadPage() {
    stopHealthPolling()
    guard AshConfig.isLocal else { return showPage() }
    AshHealth.probe(AshConfig.windowHealthURL) { probe in
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        guard let instance = AshHealth.ours(probe) else { return self.instanceLost() }
        self.bind(instance) { self.showPage() }
      }
    }
  }

  private func showPage() {
    offlineView.isHidden = true
    // 失败页、撤下后的空白页之后 webView.url 不是 ash 的，此时回到撤下前的路由或首页；正常情况下
    // 原地重载保住当前路由。
    let target = [webView.url, resumeURL].compactMap { $0 }.first(where: AshConfig.isSameOrigin) ?? AshConfig.windowURL
    resumeURL = nil
    webView.load(URLRequest(url: target))
    startInstanceGuard()
  }

  /// 页面之后发的每个请求（fetch、SSE、页面本身、预览）都带着认过的那一份的实例号。窗口连的是这份
  /// 服务专用的端口（AshConfig.windowPort），服务一停那个端口就空着，别的 ash 接不到窗口的请求；
  /// 自己那份重起过、或者有谁照着同一个端口起了一份新版 ash，实例号对不上就不执行
  /// （server/src/instance-binding.ts）。定时认人和导航前认人只负责撤页和说明。
  func bind(_ instance: AshInstance, then: @escaping () -> Void) {
    guard let id = instance.id, id != boundInstance else { return then() }
    guard let host = AshConfig.windowURL.host,
          let cookie = HTTPCookie(properties: [.name: Self.instanceCookie, .value: id, .domain: host, .path: "/"]) else {
      return then()
    }
    webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak self] in
      self?.boundInstance = id
      then()
    }
  }

  static let instanceCookie = "ash_instance"

  // MARK: 页面在的时候也一直认着人

  /// 窗口只对认过的那一份服务开着页面。导航（刷新、前进后退、页面自己跳转）放行前各认一次
  /// （WebViewBridge），已经载好的页面自己发的请求、SSE 不经过导航 —— 它们落到新来的那一份上会被
  /// 实例号挡下（见 `bind`），但页面会一直报错。所以页面在的时候还要定时认：不是自己那份了就撤掉页面、说清楚。
  private func startInstanceGuard() {
    guard AshConfig.isLocal, guardTimer == nil else { return }
    guardTimer = Timer.scheduledTimer(withTimeInterval: Self.instanceGuardInterval, repeats: true) { [weak self] _ in
      self?.checkInstance()
    }
  }

  func stopInstanceGuard() {
    guardTimer?.invalidate()
    guardTimer = nil
  }

  private func checkInstance() {
    guard !guardProbing, guardTimer != nil else { return }
    guardProbing = true
    AshHealth.probe(AshConfig.windowHealthURL) { probe in
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.guardProbing = false
        guard self.guardTimer != nil else { return }
        guard let instance = AshHealth.ours(probe) else { return self.instanceLost() }
        // 还是自己那份，但服务重起过（实例号换了）：页面手上的旧实例号会被拒，换上新的重载一遍。
        if instance.id != self.boundInstance { self.bind(instance) { self.webView.reload() } }
      }
    }
  }

  /// 端口上不再是认过的那一份：页面连同它的轮询、SSE 一起撤掉（一个请求都不再发给新来的那份），
  /// 记下路由，回到 loadHome 认一遍 —— 被占着就盖上说明，自己那份回来了再载回去。
  func instanceLost() {
    stopInstanceGuard()
    if let url = webView.url, AshConfig.isSameOrigin(url) { resumeURL = url }
    webView.stopLoading()
    webView.loadHTMLString("", baseURL: nil)
    loadHome()
  }

  /// 正在换代码（UpdateGate 停了服务）：盖上一屏、不探活，闸放开时 UpdateGate 会叫 loadHome。
  func showInstalling(_ note: String) {
    stopHealthPolling()
    stopInstanceGuard()
    pendingStartingScreen?.cancel()
    offlineView.show(title: note, detail: "装好后自动接上。接管得了的任务照常在跑；点了「现在装」的话，刚才列出的那些会被打断。", busy: true)
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
        if case .unreachable = probe { down = true }
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
    NSWorkspace.shared.open(webView.url.map(AshConfig.browserURL) ?? AshConfig.baseURL)
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
