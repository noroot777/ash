import AppKit

/// 服务不在时盖在页面上的那一屏：启动中转圈；起不来就说原因，给重试和日志。
/// 后台一直在探 /api/health，通了自动载回去，所以按钮只是给等不及的人用的。
final class OfflineView: NSView {
  var onRetry: (() -> Void)?
  private let spinner = NSProgressIndicator()
  private let headline = NSTextField(labelWithString: "")
  private let detail = NSTextField(wrappingLabelWithString: "")
  private let buttons = NSStackView()
  private var log: URL?

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true

    spinner.style = .spinning
    spinner.controlSize = .small
    headline.font = .systemFont(ofSize: 15, weight: .semibold)
    headline.alignment = .center
    detail.font = .systemFont(ofSize: 12)
    detail.textColor = .secondaryLabelColor
    detail.alignment = .center
    detail.isSelectable = true
    detail.preferredMaxLayoutWidth = 420

    let retry = NSButton(title: "重试", target: self, action: #selector(retry))
    retry.bezelStyle = .rounded
    retry.keyEquivalent = "\r"
    let openLog = NSButton(title: "日志", target: self, action: #selector(openLog))
    openLog.bezelStyle = .rounded
    buttons.setViews([openLog, retry], in: .center)
    buttons.spacing = 8

    let stack = NSStackView(views: [spinner, headline, detail, buttons])
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

  func show(title: String, detail text: String, busy: Bool, log: URL? = nil) {
    headline.stringValue = title
    detail.stringValue = text
    spinner.isHidden = !busy
    busy ? spinner.startAnimation(nil) : spinner.stopAnimation(nil)
    buttons.isHidden = busy
    self.log = log
    buttons.views.first?.isHidden = log.map { !FileManager.default.fileExists(atPath: $0.path) } ?? true
    isHidden = false
  }

  // CGColor 不跟随明暗切换；updateLayer 在当前外观下调用，切换时也会重来一次。
  override var wantsUpdateLayer: Bool { true }
  override func updateLayer() {
    layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
  }

  @objc private func retry() { onRetry?() }
  @objc private func openLog() { if let log { NSWorkspace.shared.open(log) } }

  // 盖住页面时别让点击、滚动漏到底下的 WKWebView。
  override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) ?? self }
}
