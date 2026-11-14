import AppKit
import WebKit

/// 唯一的主窗口：一个铺满的 WKWebView 加一层「连不上」时的原生占位。
final class BrowserWindowController: NSWindowController, NSWindowDelegate, NSMenuItemValidation {
  let webView: WKWebView
  let offlineView = OfflineView()
  /// 数据根还空着时盖在 offlineView 上的那一屏（LaunchFlow 的首启）。
  let firstRunView = FirstRunView()
  /// 窗口这会儿是不是首次配置那扇小窗（见 `enterWelcome`）。
  private(set) var welcoming = false
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
  /// 原生那一屏正等着交给页面（见 `Handoff`）。
  private var handoff: Handoff?
  /// 主框架换过几次文档（见 `Handoff.document`）。
  private var documentSerial = 0
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
    // 页面画出第一帧之前 WKWebView 先铺一层白：从原生那几屏（首启、启动中）切到页面时整窗闪一下白。
    // 不画自己的底，透出窗口底色（跟页面的 theme-color 走，载进来之前是同色的 AshPalette.chrome）。
    // 没有公开接口；这个键在哪一版没了就照旧画白底，不至于崩。
    if webView.responds(to: NSSelectorFromString("_setDrawsBackground:")) {
      webView.setValue(false, forKey: "drawsBackground")
    }

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
    chrome?.onWindowSize = { [weak self] size in
      if size == "setup" { self?.enterWelcome() } else { self?.leaveWelcome() }
      self?.pageDidPresent()
    }
    chrome?.onPageBroken = { [weak self] source in self?.pageDidBreak(source) }
    // 位置和大小记在 UserDefaults 里，下次原样打开。数据根还空着就先开成首启那扇小窗。
    if AshConfig.isLocal && !AshConfig.isDataInitialized {
      enterWelcome()
    } else {
      window.setFrameAutosaveName(Self.frameName)
      if !window.setFrameUsingName(Self.frameName) { window.center() }
    }

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
        self?.window?.backgroundColor = view.themeColor ?? AshPalette.chrome
      },
    ]
  }

  // MARK: 首次配置那扇小窗

  static let frameName = "AshMainWindow"
  /// 首次配置时窗口开多大：原生那一屏（FirstRunView）和随后 web 的三步向导都正好铺满它。
  static let welcomeSize = NSSize(width: 980, height: 660)
  /// 工作窗第一次打开时的大小（之后按用户拖成的样子记住）。
  static let workSize = NSSize(width: 1440, height: 900)

  /// 首次配置不开一扇 1440 的大窗在正中摆几行字：从「数据从哪儿来」到 web 向导走完，都在一扇正好装下
  /// 它们的小窗里；页面说进了工作台（WindowChrome.onWindowSize）才展开。数据根空着时一打开就是它，
  /// 已经有数据、页面却还在向导里（上次走到一半退出了）时由页面叫回来。
  /// 这期间不记窗口位置，免得之后工作窗也跟着开成这么小。仍然可以拉大 —— 万一页面没表态，人不至于被关在小窗里。
  func enterWelcome() {
    guard let window, !welcoming, !window.styleMask.contains(.fullScreen) else { return }
    welcoming = true
    window.setFrameAutosaveName("")
    window.collectionBehavior.insert(.fullScreenNone)
    let size = window.frameRect(forContentRect: NSRect(origin: .zero, size: Self.welcomeSize)).size
    guard window.isVisible else {
      window.setContentSize(Self.welcomeSize)
      window.center()
      return
    }
    // 已经开着的工作窗缩回来：以它的中心收拢。
    let frame = NSRect(x: window.frame.midX - size.width / 2, y: window.frame.midY - size.height / 2,
                       width: size.width, height: size.height)
    window.setFrame(fitted(frame, in: window), display: true, animate: true)
  }

  /// 进了工作台：展开成工作窗。以前记过工作窗的位置就回到那里，没有就以小窗的中心展开、收在屏幕里。
  func leaveWelcome() {
    guard let window, welcoming else { return }
    welcoming = false
    window.collectionBehavior.remove(.fullScreenNone)
    let target = Self.savedFrame() ?? NSRect(
      x: window.frame.midX - Self.workSize.width / 2, y: window.frame.midY - Self.workSize.height / 2,
      width: Self.workSize.width, height: Self.workSize.height)
    window.setFrame(fitted(target, in: window), display: true, animate: true)
    window.setFrameAutosaveName(Self.frameName)
  }

  /// 收进窗口所在屏幕的可用区域里。
  private func fitted(_ frame: NSRect, in window: NSWindow) -> NSRect {
    guard let visible = (window.screen ?? NSScreen.main)?.visibleFrame else { return frame }
    var rect = frame
    rect.size.width = min(rect.width, visible.width)
    rect.size.height = min(rect.height, visible.height)
    rect.origin.x = min(max(rect.minX, visible.minX), visible.maxX - rect.width)
    rect.origin.y = min(max(rect.minY, visible.minY), visible.maxY - rect.height)
    return rect
  }

  /// AppKit 记下的工作窗位置（`NSWindow Frame <名字>`，前四个数是 x y 宽 高）。
  private static func savedFrame() -> NSRect? {
    guard let raw = UserDefaults.standard.string(forKey: "NSWindow Frame \(frameName)") else { return nil }
    let numbers = raw.split(separator: " ").compactMap { Double($0) }
    guard numbers.count >= 4, numbers[2] > 0, numbers[3] > 0 else { return nil }
    return NSRect(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3])
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
    beginHandoff()
    // 失败页、撤下后的空白页之后 webView.url 不是 ash 的，此时回到撤下前的路由或首页；正常情况下
    // 原地重载保住当前路由。
    let target = [webView.url, resumeURL].compactMap { $0 }.first(where: AshConfig.isSameOrigin) ?? AshConfig.windowURL
    resumeURL = nil
    webView.load(URLRequest(url: target))
    startInstanceGuard()
  }

  // MARK: 原生那一屏交给页面

  /// 服务通了只说明页面载得进来，不说明它已经画出来了：HTML、脚本、身份确认都还在路上，入口脚本也可能根本没载成。
  /// 所以盖着的那一屏（首启卡上的转圈、「正在启动」）只交给**表了态的页面**：当前文档提交之后报了这一屏要多大的窗
  /// （WindowChrome.onWindowSize —— 认约定的页面在身份确认、画出第一屏或报错屏时报；不认约定的文档读完 <head>
  /// 时报，它的内容就在 HTML 里）。主文档载完、过了多久都不算数。
  ///
  /// 等不到就换上一屏持久的说明，给「重试」和「仍然显示页面」（后者给不报尺寸的旧版 ash 留一条明确的路），
  /// 不把空页面放出来：入口脚本没载成（页面脚本报回来）当场换，一直没表态的等 `presentTimeout`。说明屏还认这一次
  /// 交接，页面后来还是画出来了就照样接上。中途盖上了别的一屏（载入失败、又一次「正在启动」）不撤它，那一屏有自己的去处。
  private struct Handoff {
    /// 开始载入以来主框架第几次换文档（`documentSerial`）。表态和计时都只认当前这一份文档，
    /// 上一份留下的（页面载完马上自己跳走时）作废。
    var document: Int?
    /// 到点该撤的是 offlineView 的哪一屏（`OfflineView.revision`）。
    var screen: Int
  }

  /// 新文档提交后最多等它多久表态。认约定的页面身份确认通常在一秒内；再久就是出事了。
  static var presentTimeout: TimeInterval = 15

  private func beginHandoff() {
    handoff = offlineView.isHidden ? nil : Handoff(document: nil, screen: offlineView.revision)
  }

  /// 主框架换上了新文档（WebViewBridge）。不比对是哪一次导航：页面自己的跳转顶掉了这一次也一样，
  /// 等的是「窗口里这份文档表态」，计时从这份文档算起。
  func pageDidCommit() {
    documentSerial += 1
    guard handoff != nil else { return }
    let document = documentSerial
    handoff?.document = document
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.presentTimeout) { [weak self] in
      guard let self, self.handoff?.document == document else { return }
      self.pageDidNotPresent("页面载进来了，但等了 \(Int(Self.presentTimeout)) 秒还没显示出来。")
    }
  }

  private func pageDidPresent() {
    guard let pending = handoff, pending.document == documentSerial else { return }
    handoff = nil
    if offlineView.revision == pending.screen { offlineView.isHidden = true }
  }

  /// 当前文档的脚本没载成（WindowChrome 报回来）：不再等它表态。
  private func pageDidBreak(_ source: String) {
    guard let pending = handoff, pending.document == documentSerial else { return }
    let name = URL(string: source).map { $0.path.isEmpty ? source : $0.path } ?? source
    pageDidNotPresent("页面的脚本（\(name)）没有载进来。")
  }

  private func pageDidNotPresent(_ reason: String) {
    guard handoff != nil else { return }
    offlineView.show(title: "页面没有显示出来", detail: "\(reason)\n可以重试；要先看看页面现在的样子也行。", actions: [
      OfflineView.Action(title: "仍然显示页面") { [weak self] in
        self?.handoff = nil
        self?.offlineView.isHidden = true
      },
      OfflineView.Action(title: "重试") { [weak self] in self?.loadHome() },
    ])
    // 这一屏仍算这次交接要撤的那一屏：页面只是慢、后来还是画出来了，就照样接上。
    handoff?.screen = offlineView.revision
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
    // 下面换上的空白文档也会「提交、载完」，别把它当成页面接上了。
    handoff = nil
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
