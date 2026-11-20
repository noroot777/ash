import AppKit

/// `navi://open?project=&task=&instance=&fallback=`：桌面端飞书卡片上「在 Navi 中打开」那条（server/src/im/app-link.ts
/// 只在服务只听本机时放在按钮的 pc_url 上）。系统把它交给 app（Info.plist 的 CFBundleURLTypes，build.sh 生成）。
///
/// 发卡的那份 Navi 不一定是这个 app 连着的那份（另一台 Mac 发的卡、这台 app 指着别处），所以链接自带来源：
/// `instance` 是发卡那份的指纹（server/src/instance-tag.ts），`fallback` 是原来那条 http 地址。自家服务报的
/// 指纹对上才在窗口里打开那个任务；对不上、认不出就把 http 地址交给浏览器，不在这个工作台里打开一个同号的任务。
///
/// 任何网页都能发起这种链接，所以它只能「导航」：只收 project / task 两个 id、一个指纹，fallback 只收
/// 指着同一个任务的 http(s) 地址，别的一概不认 —— 认不出的链接只把窗口拉到前面。
enum DeepLink {
  struct Link: Equatable {
    /// 工作台里对应的路由（`/?project=&task=`）。
    let route: String
    let instance: String?
    let fallback: URL?
  }

  enum Action: Equatable {
    case window(String)
    case browser(URL)
    case front
  }

  private static let idPattern = "^[A-Za-z0-9_-]{1,80}$"
  private static let tagPattern = "^[0-9A-F]{4}-[0-9A-F]{4}$"

  static func parse(_ url: URL) -> Link? {
    guard url.scheme?.lowercased() == "navi", url.host?.lowercased() == "open",
          let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
    let value = { (name: String) in items.first(where: { $0.name == name })?.value }
    var query: [URLQueryItem] = []
    for key in ["project", "task"] {
      guard let id = value(key) else { continue }
      guard matches(id, idPattern) else { return nil }
      query.append(URLQueryItem(name: key, value: id))
    }
    guard query.first?.name == "project" else { return nil }
    var parts = URLComponents()
    parts.path = "/"
    parts.queryItems = query
    guard let route = parts.string else { return nil }
    let instance = value("instance")
    if let instance, !matches(instance, tagPattern) { return nil }
    var fallback: URL?
    if let raw = value("fallback") {
      guard let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
            let fallbackItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
            query.allSatisfy({ item in fallbackItems.first(where: { $0.name == item.name })?.value == item.value }) else { return nil }
      fallback = url
    }
    return Link(route: route, instance: instance, fallback: fallback)
  }

  /// `servedTag`：自家服务报的指纹；没认出自家服务（没起来、被占着、app 指着别处的 navi）时是 nil。
  static func decide(_ link: Link, servedTag: String?) -> Action {
    if let servedTag, link.instance == nil || link.instance == servedTag { return .window(link.route) }
    return link.fallback.map(Action.browser) ?? .front
  }

  private static func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
  }
}

extension BrowserWindowController {
  /// 收到一条 navi:// 链接：窗口拉到前面，等自家服务就绪、认过它的指纹再决定在窗口里开还是交给浏览器。
  /// 连着点了几条时只有最后一条落地（linkSerial）：每条的回调各等各的，晚回来的旧链接不许把窗口带回去。
  func open(link url: URL) {
    showWindow(nil)
    if window?.isMiniaturized == true { window?.deminiaturize(nil) }
    NSApp.activate(ignoringOtherApps: true)
    linkSerial += 1
    let serial = linkSerial
    guard let link = DeepLink.parse(url) else { return }
    ServerLauncher.shared.ensureRunning { [weak self] outcome in
      guard case .ready = outcome else { self?.perform(DeepLink.decide(link, servedTag: nil), serial: serial); return }
      NaviHealth.probe(NaviConfig.windowHealthURL) { probe in
        let tag = NaviHealth.ours(probe)?.tag
        DispatchQueue.main.async { self?.perform(DeepLink.decide(link, servedTag: tag), serial: serial) }
      }
    }
  }

  private func perform(_ action: DeepLink.Action, serial: Int) {
    guard serial == linkSerial else { return }
    switch action {
    case .front: return
    case .browser(let url): NSWorkspace.shared.open(url)
    case .window(let route): navigate(to: route)
    }
  }

  /// 页面在着就原地换路由（同 web 里 git-workbench/navigation.ts 那样推一条历史、发一次 popstate），不重载；
  /// 页面还没载进来（服务在起、被占着、首启）就记下，载页面时直接载到那里。
  private func navigate(to route: String) {
    guard let target = URL(string: route, relativeTo: NaviConfig.windowURL)?.absoluteURL else { return }
    guard let current = webView.url, NaviConfig.isSameOrigin(current) else {
      pendingRoute = target
      return
    }
    guard !webView.isLoading, let json = try? JSONEncoder().encode(route), let literal = String(data: json, encoding: .utf8) else {
      webView.load(URLRequest(url: target))
      return
    }
    webView.evaluateJavaScript("history.pushState(null, '', \(literal)); dispatchEvent(new PopStateEvent('popstate'))") { [weak self] _, error in
      if error != nil { self?.webView.load(URLRequest(url: target)) }
    }
  }
}
