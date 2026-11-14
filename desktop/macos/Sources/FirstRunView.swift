import AppKit

/// 第一次打开、数据根还空着时的那张卡：数据从哪儿来。
///
/// 和接下来 web 的首启向导是同一张脸（`web/src/auth/SetupWizard.tsx` 那张「这台 ash 给谁用？」：
/// 灰底上一张白卡，两个整块可点的选项），点完接上页面时不跳样式。选了之后不换屏：选中的那一项
/// 原地转圈，等页面载进来；出了错回到这张卡，原因写在选项底下。
final class FirstRunView: NSView {
  enum Choice { case fresh, importData }

  var onChoose: ((Choice) -> Void)?

  private static let width: CGFloat = 560
  private static let padding: CGFloat = 28

  private let icon = NSImageView()
  private let note = NSTextField(wrappingLabelWithString: "")
  private let error = NSTextField(wrappingLabelWithString: "")
  private let fresh = ChoiceButton(title: "全新开始", detail: "从空白开始，接着配好模型、执行器和项目。")
  private let importer = ChoiceButton(title: "导入已有数据…", detail: "从另一份 ash 的数据目录复制过来，原来那份不动。")

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.cornerRadius = 14
    layer?.borderWidth = 1
    layer?.masksToBounds = false

    icon.image = NSApp.applicationIconImage
    icon.imageScaling = .scaleProportionallyUpOrDown
    let title = NSTextField(labelWithString: "欢迎使用 ash")
    title.font = .systemFont(ofSize: 20, weight: .semibold)
    title.textColor = AshPalette.ink
    for (label, color) in [(note, AshPalette.muted), (error, AshPalette.red)] {
      label.font = .systemFont(ofSize: 13)
      label.textColor = color
      label.isSelectable = true
      label.preferredMaxLayoutWidth = Self.width - Self.padding * 2
    }
    error.isHidden = true
    fresh.onPress = { [weak self] in self?.onChoose?(.fresh) }
    importer.onPress = { [weak self] in self?.onChoose?(.importData) }

    let stack = NSStackView(views: [icon, title, note, fresh, importer, error])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 14
    stack.setCustomSpacing(16, after: icon)
    stack.setCustomSpacing(6, after: title)
    stack.setCustomSpacing(20, after: note)
    stack.edgeInsets = NSEdgeInsets(top: Self.padding, left: Self.padding, bottom: Self.padding, right: Self.padding)
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      widthAnchor.constraint(equalToConstant: Self.width),
      stack.leadingAnchor.constraint(equalTo: leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor),
      stack.topAnchor.constraint(equalTo: topAnchor),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor),
      icon.widthAnchor.constraint(equalToConstant: 52),
      icon.heightAnchor.constraint(equalToConstant: 52),
      fresh.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -Self.padding * 2),
      importer.widthAnchor.constraint(equalTo: fresh.widthAnchor),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  /// 回到可选的样子。`problem` 是上一次没成的原因（导入失败、选的目录不对），写在选项底下。
  func reset(dataPath: String, problem: String? = nil) {
    note.stringValue = "数据放在 \((dataPath as NSString).abbreviatingWithTildeInPath)。"
    error.stringValue = problem ?? ""
    error.isHidden = problem == nil
    for button in [fresh, importer] { button.state = .idle }
  }

  /// 选中的那一项原地转圈、说在做什么，另一项点不了。
  func setBusy(_ choice: Choice, detail: String) {
    error.isHidden = true
    let (active, other) = choice == .fresh ? (fresh, importer) : (importer, fresh)
    active.state = .busy(detail)
    other.state = .disabled
  }

  // 卡片的底、边和阴影都是 CALayer 上的颜色，不跟外观翻面；updateLayer 在当前外观下调用，切换时会重来。
  override var wantsUpdateLayer: Bool { true }
  override func updateLayer() {
    guard let layer else { return }
    layer.backgroundColor = AshPalette.panel.cgColor
    layer.borderColor = AshPalette.line.cgColor
    layer.shadowColor = NSColor.black.cgColor
    layer.shadowOpacity = AshPalette.isDark(effectiveAppearance) ? 0.4 : 0.1
    layer.shadowRadius = 22
    layer.shadowOffset = NSSize(width: 0, height: -6)
  }

  override func layout() {
    super.layout()
    layer?.shadowPath = CGPath(roundedRect: bounds, cornerWidth: 14, cornerHeight: 14, transform: nil)
  }
}

/// 卡片里一整块可点的选项：粗一点的标题加一行说明（同 web 的 `.auth-choice`）。
/// 整块都是按钮：键盘 Tab 走得到、空格回车按得下，读屏读作按钮。
final class ChoiceButton: NSControl {
  enum State: Equatable {
    case idle, disabled
    case busy(String)
  }

  var onPress: (() -> Void)?
  var state: State = .idle { didSet { apply() } }

  private let title = NSTextField(labelWithString: "")
  private let detail = NSTextField(wrappingLabelWithString: "")
  private let spinner = NSProgressIndicator()
  private let idleDetail: String
  private var hovering = false { didSet { needsDisplay = true } }
  private var pressing = false { didSet { needsDisplay = true } }

  init(title text: String, detail description: String) {
    idleDetail = description
    super.init(frame: .zero)
    wantsLayer = true
    layer?.cornerRadius = 12
    layer?.borderWidth = 1

    title.stringValue = text
    title.font = .systemFont(ofSize: 14, weight: .semibold)
    title.textColor = AshPalette.ink
    detail.font = .systemFont(ofSize: 12.5)
    detail.textColor = AshPalette.muted
    // 外层卡片 560 - 两边 28 - 选项自己两边 16 - 右边给转圈留的 28。
    detail.preferredMaxLayoutWidth = 560 - 56 - 32 - 28
    spinner.style = .spinning
    spinner.controlSize = .small
    spinner.isDisplayedWhenStopped = false

    let text = NSStackView(views: [title, detail])
    text.orientation = .vertical
    text.alignment = .leading
    text.spacing = 5
    for view in [text, spinner] as [NSView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }
    NSLayoutConstraint.activate([
      text.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      text.trailingAnchor.constraint(lessThanOrEqualTo: spinner.leadingAnchor, constant: -12),
      text.topAnchor.constraint(equalTo: topAnchor, constant: 14),
      text.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),
      spinner.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      spinner.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
    apply()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  private var pressable: Bool { state == .idle }

  private func apply() {
    if case .busy(let note) = state {
      detail.stringValue = note
      spinner.startAnimation(nil)
    } else {
      detail.stringValue = idleDetail
      spinner.stopAnimation(nil)
    }
    alphaValue = state == .disabled ? 0.5 : 1
    if !pressable { hovering = false; pressing = false }
    needsDisplay = true
    setAccessibilityEnabled(pressable)
  }

  override var wantsUpdateLayer: Bool { true }
  override func updateLayer() {
    guard let layer else { return }
    let lit = pressable && (hovering || pressing)
    layer.backgroundColor = (lit ? AshPalette.hover : AshPalette.raised).cgColor
    layer.borderColor = (lit ? AshPalette.ink : AshPalette.line).cgColor
  }

  // 标题、说明都是 label，点在它们上面也算点这一块。
  override func hitTest(_ point: NSPoint) -> NSView? {
    !isHidden && frame.contains(point) ? self : nil
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                   owner: self, userInfo: nil))
  }

  override func mouseEntered(with event: NSEvent) { if pressable { hovering = true } }
  override func mouseExited(with event: NSEvent) { hovering = false }

  override func mouseDown(with event: NSEvent) {
    guard pressable else { return }
    pressing = true
    // 按下后拖出去再松开不算一次点击，和系统按钮一样。
    while let next = window?.nextEvent(matching: [.leftMouseUp, .leftMouseDragged]) {
      let inside = bounds.contains(convert(next.locationInWindow, from: nil))
      if next.type == .leftMouseUp {
        pressing = false
        hovering = inside
        if inside { press() }
        return
      }
      pressing = inside
    }
  }

  private func press() {
    guard pressable else { return }
    onPress?()
  }

  // MARK: 键盘与读屏

  override var acceptsFirstResponder: Bool { pressable }
  override var canBecomeKeyView: Bool { pressable }
  override func keyDown(with event: NSEvent) {
    if [" ", "\r"].contains(event.charactersIgnoringModifiers) { press() } else { super.keyDown(with: event) }
  }

  override var focusRingMaskBounds: NSRect { bounds }
  override func drawFocusRingMask() {
    NSBezierPath(roundedRect: bounds, xRadius: 12, yRadius: 12).fill()
  }

  override func isAccessibilityElement() -> Bool { true }
  override func accessibilityRole() -> NSAccessibility.Role? { .button }
  override func accessibilityLabel() -> String? { title.stringValue }
  override func accessibilityHelp() -> String? { detail.stringValue }
  override func accessibilityPerformPress() -> Bool {
    guard pressable else { return false }
    press()
    return true
  }
}
