import AppKit

/// 连不上 ash 时盖在页面上的那一屏：一句话说清连的哪、为什么，外加一个重试。
/// 后台每 2 秒自动探活，所以按钮只是给等不及的人用的。
final class OfflineView: NSView {
  var onRetry: (() -> Void)?
  private let headline = NSTextField(labelWithString: "")
  private let detail = NSTextField(wrappingLabelWithString: "")

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true

    headline.font = .systemFont(ofSize: 15, weight: .semibold)
    headline.alignment = .center
    detail.font = .systemFont(ofSize: 12)
    detail.textColor = .secondaryLabelColor
    detail.alignment = .center
    detail.preferredMaxLayoutWidth = 420

    let retry = NSButton(title: "重试", target: self, action: #selector(retry))
    retry.bezelStyle = .rounded
    retry.keyEquivalent = "\r"

    let stack = NSStackView(views: [headline, detail, retry])
    stack.orientation = .vertical
    stack.spacing = 10
    stack.setCustomSpacing(18, after: detail)
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor),
      stack.widthAnchor.constraint(lessThanOrEqualToConstant: 440),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  func show(address: String, detail text: String) {
    headline.stringValue = "连不上 \(address)"
    detail.stringValue = "\(text)\n服务起来后会自动载入。"
    isHidden = false
  }

  // CGColor 不跟随明暗切换；updateLayer 在当前外观下调用，切换时也会重来一次。
  override var wantsUpdateLayer: Bool { true }
  override func updateLayer() {
    layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
  }

  @objc private func retry() { onRetry?() }

  // 盖住页面时别让点击、滚动漏到底下的 WKWebView。
  override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) ?? self }
}
