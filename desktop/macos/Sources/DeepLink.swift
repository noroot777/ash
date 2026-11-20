import AppKit

/// `navi://open?project=<项目>&task=<任务>`：桌面端飞书卡片上「在 Navi 中打开」那条（server/src/im/app-link.ts
/// 放在按钮的 pc_url 上）。系统把它交给 app（Info.plist 的 CFBundleURLTypes，build.sh 生成），app 把窗口
/// 拉到前面、打开那个任务。
///
/// 任何网页都能发起这种链接，所以它只能「导航」：只收 project / task 两个参数、只收 id 的字形，拼成工作台的
/// 路由，别的一概不认 —— 认不出的链接只把窗口拉到前面。
enum DeepLink {
  /// 工作台里对应的路由（`/?project=&task=`）；不是认得的链接时是 nil。
  static func route(_ url: URL) -> String? {
    guard url.scheme?.lowercased() == "navi", url.host?.lowercased() == "open",
          let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
    var query: [URLQueryItem] = []
    for key in ["project", "task"] {
      guard let value = items.first(where: { $0.name == key })?.value else { continue }
      guard value.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil else { return nil }
      query.append(URLQueryItem(name: key, value: value))
    }
    guard query.first?.name == "project" else { return nil }
    var parts = URLComponents()
    parts.path = "/"
    parts.queryItems = query
    return parts.string
  }
}

extension BrowserWindowController {
  /// 收到一条 navi:// 链接。页面在着就原地换路由（同 web 里 git-workbench/navigation.ts 那样推一条历史、
  /// 发一次 popstate），不重载；页面还没载进来（服务在起、被占着、首启）就记下，载页面时直接载到那里。
  func open(link url: URL) {
    showWindow(nil)
    if window?.isMiniaturized == true { window?.deminiaturize(nil) }
    NSApp.activate(ignoringOtherApps: true)
    guard let route = DeepLink.route(url), let target = URL(string: route, relativeTo: NaviConfig.windowURL)?.absoluteURL else { return }
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
