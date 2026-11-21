import AppKit
import WebKit

/// 页面载不进来时盖在上面的那一屏：启动中播放品牌动画；起不来、端口被占着就说原因。按钮由调用方给，
/// 最后一个是默认按钮（回车）。首启那一屏（FirstRunView）也盖在这一层上，由 `show(panel:)` 摆上来。
/// 服务不在、端口被占着的那几种情形后台一直在探 /api/health，通了（或占着的那份停了）自动接上，
/// 按钮只是给等不及的人用的。
final class OfflineView: NSView {
  struct Action {
    let title: String
    let run: () -> Void
  }

  private let brand = OfflineBrandView()
  private let headline = NSTextField(wrappingLabelWithString: "")
  private let detail = NSTextField(wrappingLabelWithString: "")
  private let buttons = NSStackView()
  private let stack: NSStackView
  private var panel: NSView?
  private var actions: [Action] = []
  private var busy = false
  override var isHidden: Bool {
    didSet { brand.setAnimating(busy && !isHidden && panel == nil) }
  }
  /// 每换一次屏加一：页面接上时只撤自己开始载入那会儿盖着的那一屏（见 BrowserWindowController 的 `Handoff`），
  /// 中途换上来的错误说明不跟着撤。
  private(set) var revision = 0

  override init(frame: NSRect) {
    stack = NSStackView(views: [brand, headline, detail, buttons])
    super.init(frame: frame)
    wantsLayer = true

    headline.font = .systemFont(ofSize: 22, weight: .semibold)
    headline.textColor = NaviPalette.ink
    headline.alignment = .center
    detail.font = .systemFont(ofSize: 13)
    detail.textColor = NaviPalette.muted
    detail.alignment = .center
    detail.isSelectable = true
    detail.preferredMaxLayoutWidth = 420

    buttons.spacing = 8

    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 10
    stack.setCustomSpacing(28, after: brand)
    stack.setCustomSpacing(22, after: detail)
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    let preferredWidth = stack.widthAnchor.constraint(equalToConstant: 440)
    preferredWidth.priority = NSLayoutConstraint.Priority(999)
    preferredWidth.isActive = true
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -12),
      stack.widthAnchor.constraint(lessThanOrEqualToConstant: 440),
      stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 28),
      stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -28),
      headline.widthAnchor.constraint(equalTo: stack.widthAnchor),
      detail.widthAnchor.constraint(equalTo: stack.widthAnchor),
      brand.widthAnchor.constraint(equalToConstant: 128),
      brand.heightAnchor.constraint(equalToConstant: 128),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  func show(title: String, detail text: String, busy: Bool = false, actions: [Action] = []) {
    revision += 1
    removePanel()
    stack.isHidden = false
    headline.stringValue = title
    detail.stringValue = text
    detail.isHidden = text.isEmpty
    self.busy = busy
    self.actions = actions
    let views = actions.enumerated().map { index, action -> NSButton in
      let button = NSButton(title: action.title, target: self, action: #selector(press(_:)))
      button.bezelStyle = .rounded
      button.tag = index
      if index == actions.count - 1 { button.keyEquivalent = "\r" }
      return button
    }
    buttons.setViews(views, in: .center)
    buttons.isHidden = views.isEmpty
    isHidden = false
  }

  /// 换成一块自带内容的面板（首启那一屏），铺满；再 `show(title:…)` 时收走。
  func show(panel view: NSView) {
    revision += 1
    if panel !== view {
      removePanel()
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
      NSLayoutConstraint.activate([
        view.leadingAnchor.constraint(equalTo: leadingAnchor),
        view.trailingAnchor.constraint(equalTo: trailingAnchor),
        view.topAnchor.constraint(equalTo: topAnchor),
        view.bottomAnchor.constraint(equalTo: bottomAnchor),
      ])
      panel = view
    }
    stack.isHidden = true
    busy = false
    actions = []
    isHidden = false
  }

  private func removePanel() {
    panel?.removeFromSuperview()
    panel = nil
  }

  // CGColor 不跟随明暗切换；updateLayer 在当前外观下调用，切换时也会重来一次。
  override var wantsUpdateLayer: Bool { true }
  override func updateLayer() {
    layer?.backgroundColor = NaviPalette.chrome.cgColor
  }

  @objc private func press(_ sender: NSButton) { actions[sender.tag].run() }

  // 不重写 hitTest：AppKit 默认就是「显示时盖住的范围归自己、隐藏时返回 nil」，点击既不会
  // 漏到底下的页面，也不会在占位收起后继续被吞。曾写成 `super.hitTest(point) ?? self`，
  // 隐藏时 super 返回 nil 被兜成 self，整个窗口点什么都没反应。
}

private final class OfflineBrandView: NSView, WKNavigationDelegate {
  private let webView = WKWebView(frame: .zero)
  private var animating = false

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.cornerRadius = 30
    layer?.borderWidth = 1
    let fallback = NSImageView(image: NSApp.applicationIconImage)
    fallback.imageScaling = .scaleProportionallyUpOrDown
    for view in [fallback, webView] as [NSView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
      NSLayoutConstraint.activate([
        view.centerXAnchor.constraint(equalTo: centerXAnchor),
        view.centerYAnchor.constraint(equalTo: centerYAnchor),
        view.widthAnchor.constraint(equalToConstant: 80),
        view.heightAnchor.constraint(equalToConstant: 80),
      ])
    }
    webView.isHidden = true
    webView.navigationDelegate = self
    webView.setAccessibilityElement(false)
    setAccessibilityElement(false)
    if webView.responds(to: NSSelectorFromString("_setDrawsBackground:")) {
      webView.setValue(false, forKey: "drawsBackground")
    }
    guard let url = Bundle.main.url(forResource: "loader", withExtension: "svg"),
          let svg = try? String(contentsOf: url, encoding: .utf8) else { return }
    webView.loadHTMLString("""
      <!doctype html><html><head><meta name="color-scheme" content="light dark">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
      <style>
        html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
        body{display:grid;place-items:center;pointer-events:none}
        svg{width:80px;height:80px}
        html .navi-loader .navi-mark__needle{animation-play-state:paused}
        html[data-busy] .navi-mark__needle{animation-play-state:running}
        @media(prefers-reduced-motion:reduce){.navi-loader .navi-mark__needle{animation:none!important}}
      </style></head><body aria-hidden="true">\(svg)</body></html>
      """, baseURL: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  func setAnimating(_ value: Bool) {
    animating = value
    webView.evaluateJavaScript("document.documentElement.toggleAttribute('data-busy', \(value))", completionHandler: nil)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    setAnimating(animating)
    subviews.first?.isHidden = true
    webView.isHidden = false
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override var wantsUpdateLayer: Bool { true }
  override func updateLayer() {
    layer?.backgroundColor = NaviPalette.panel.cgColor
    layer?.borderColor = NaviPalette.line.cgColor
    webView.appearance = effectiveAppearance
    webView.underPageBackgroundColor = NaviPalette.panel
  }
}
