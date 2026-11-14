import AppKit

/// 页面载不进来时盖在上面的那一屏：启动中转圈；起不来、端口被占着就说原因；首启时问
/// 「全新开始 / 导入已有数据」。按钮由调用方给，最后一个是默认按钮（回车）。
/// 服务不在、端口被占着的那几种情形后台一直在探 /api/health，通了（或占着的那份停了）自动接上，
/// 按钮只是给等不及的人用的。
final class OfflineView: NSView {
  struct Action {
    let title: String
    let run: () -> Void
  }

  private let spinner = NSProgressIndicator()
  private let headline = NSTextField(labelWithString: "")
  private let detail = NSTextField(wrappingLabelWithString: "")
  private let buttons = NSStackView()
  private var actions: [Action] = []

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

  func show(title: String, detail text: String, busy: Bool = false, actions: [Action] = []) {
    headline.stringValue = title
    detail.stringValue = text
    spinner.isHidden = !busy
    busy ? spinner.startAnimation(nil) : spinner.stopAnimation(nil)
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

  // CGColor 不跟随明暗切换；updateLayer 在当前外观下调用，切换时也会重来一次。
  override var wantsUpdateLayer: Bool { true }
  override func updateLayer() {
    layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
  }

  @objc private func press(_ sender: NSButton) { actions[sender.tag].run() }

  // 不重写 hitTest：AppKit 默认就是「显示时盖住的范围归自己、隐藏时返回 nil」，点击既不会
  // 漏到底下的页面，也不会在占位收起后继续被吞。曾写成 `super.hitTest(point) ?? self`，
  // 隐藏时 super 返回 nil 被兜成 self，整个窗口点什么都没反应。
}
