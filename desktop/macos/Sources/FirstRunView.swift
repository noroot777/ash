import AppKit

/// 第一次打开、数据根还空着时的那一屏：铺满首次配置那扇小窗（`BrowserWindowController.welcomeSize`），
/// 不是大窗正中摆一张卡。左边一栏是 ash 自己和首启要走的几步（第一步就是这里，后三步是 web 的首启
/// 向导，名字和它导轨上的一致）；右边问数据从哪儿来。
///
/// 选了之后不换屏：选中的那一项原地转圈，等页面载进来（窗口这时才展开成工作窗）；出了错回到这里，
/// 原因写在选项底下。
final class FirstRunView: NSView {
  enum Choice { case fresh, importData }

  var onChoose: ((Choice) -> Void)?

  static let brandWidth: CGFloat = 340
  private static let inset: CGFloat = 56
  /// 右边那一栏里内容的宽度：窗宽减左栏、减两边留白。
  private static let columnWidth = BrowserWindowController.welcomeSize.width - brandWidth - inset * 2

  private let brand = BrandPane()
  private let error = NSTextField(wrappingLabelWithString: "")
  private let location = NSTextField(wrappingLabelWithString: "")
  private let fresh = ChoiceButton(title: "全新开始", detail: "从空白开始，接着配好供应商、执行器和项目。",
                                   textWidth: columnWidth)
  private let importer = ChoiceButton(title: "导入已有数据…", detail: "从另一份 ash 的数据目录复制过来，原来那份不动。",
                                      textWidth: columnWidth)

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true

    let title = NSTextField(labelWithString: "数据从哪儿来")
    title.font = .systemFont(ofSize: 22, weight: .semibold)
    title.textColor = AshPalette.ink
    let note = NSTextField(labelWithString: "只在第一次打开时问这一次。")
    note.font = .systemFont(ofSize: 13)
    note.textColor = AshPalette.muted
    error.font = .systemFont(ofSize: 13)
    error.textColor = AshPalette.red
    error.isSelectable = true
    error.preferredMaxLayoutWidth = Self.columnWidth
    error.isHidden = true
    location.font = .systemFont(ofSize: 12)
    location.textColor = AshPalette.faint
    location.isSelectable = true
    location.preferredMaxLayoutWidth = Self.columnWidth
    fresh.onPress = { [weak self] in self?.onChoose?(.fresh) }
    importer.onPress = { [weak self] in self?.onChoose?(.importData) }

    let column = NSStackView(views: [title, note, fresh, importer, error])
    column.orientation = .vertical
    column.alignment = .leading
    column.spacing = 12
    column.setCustomSpacing(8, after: title)
    column.setCustomSpacing(28, after: note)
    column.setCustomSpacing(16, after: importer)

    for view in [brand, column, location] as [NSView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }
    NSLayoutConstraint.activate([
      brand.leadingAnchor.constraint(equalTo: leadingAnchor),
      brand.topAnchor.constraint(equalTo: topAnchor),
      brand.bottomAnchor.constraint(equalTo: bottomAnchor),
      brand.widthAnchor.constraint(equalToConstant: Self.brandWidth),

      column.leadingAnchor.constraint(equalTo: brand.trailingAnchor, constant: Self.inset),
      column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Self.inset),
      // 比正中略高一点：底下还压着一行数据位置。
      column.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -12),
      fresh.widthAnchor.constraint(equalTo: column.widthAnchor),
      importer.widthAnchor.constraint(equalTo: column.widthAnchor),

      location.leadingAnchor.constraint(equalTo: column.leadingAnchor),
      location.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -Self.inset),
      location.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -40),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  /// 回到可选的样子。`problem` 是上一次没成的原因（导入失败、选的目录不对），写在选项底下。
  func reset(dataPath: String, problem: String? = nil) {
    location.stringValue = "数据放在 \((dataPath as NSString).abbreviatingWithTildeInPath)"
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

  override var wantsUpdateLayer: Bool { true }
  override func updateLayer() {
    layer?.backgroundColor = AshPalette.panel.cgColor
  }
}

/// 左边那一栏：标识、一句话说 ash 是干什么的，底下是首启要走的几步。红绿灯浮在它上面。
/// 黑底白字两种外观都一样，所以颜色是写死的白，只有底色跟外观走。
private final class BrandPane: NSView {
  static let steps = ["数据", "供应商", "执行器", "项目"]

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true

    let name = NSTextField(labelWithString: "ash")
    name.font = .systemFont(ofSize: 30, weight: .semibold)
    name.textColor = .white
    let pitch = NSTextField(wrappingLabelWithString: "")
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = 5
    pitch.attributedStringValue = NSAttributedString(
      string: "把活派给本机的 claude、codex，\n进度、审查、验收都在这一处。",
      attributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.white.withAlphaComponent(0.62),
                   .paragraphStyle: paragraph])
    pitch.preferredMaxLayoutWidth = FirstRunView.brandWidth - 80

    let head = NSStackView(views: [BrandMark(), name, pitch])
    head.orientation = .vertical
    head.alignment = .leading
    head.spacing = 10
    head.setCustomSpacing(22, after: head.views[0])

    let path = NSStackView(views: Self.steps.enumerated().map { StepRow(label: $0.element, current: $0.offset == 0) })
    path.orientation = .vertical
    path.alignment = .leading
    path.spacing = 14

    for view in [head, path] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }
    NSLayoutConstraint.activate([
      head.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 40),
      head.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -40),
      // 红绿灯底下留出一截再开始。
      head.topAnchor.constraint(equalTo: topAnchor, constant: 84),
      path.leadingAnchor.constraint(equalTo: head.leadingAnchor),
      path.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -40),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  override var wantsUpdateLayer: Bool { true }
  override func updateLayer() {
    layer?.backgroundColor = AshPalette.brand.cgColor
  }
}

/// 和 app 图标同一个字形，反过来：白底黑字，放在黑栏上。画法同 scripts/make-icon.swift。
private final class BrandMark: NSView {
  override var intrinsicContentSize: NSSize { NSSize(width: 44, height: 44) }

  override func draw(_ dirtyRect: NSRect) {
    NSColor.white.setFill()
    NSBezierPath(roundedRect: bounds, xRadius: bounds.width * 0.225, yRadius: bounds.width * 0.225).fill()
    let font = NSFont.systemFont(ofSize: bounds.height * 0.62, weight: .semibold)
    let glyph = NSAttributedString(string: "a", attributes: [.font: font, .foregroundColor: NSColor.black])
    // 按 x 高居中：小写字母按行高放会偏下。
    let baseline = bounds.midY - font.xHeight / 2
    glyph.draw(at: NSPoint(x: bounds.midX - glyph.size().width / 2, y: baseline + font.descender))
  }
}

/// 首次配置路上的一站：一个圆点加名字，当前这站点亮。不标序号：后三站在 web 向导的导轨上另有编号，
/// 两边各数各的会打架。
private final class StepRow: NSStackView {
  init(label: String, current: Bool) {
    super.init(frame: .zero)
    // 圆点摆在一个 14 的格子里：web 向导那边走过的站换成 14 的勾，两边字的起点要对齐，切屏时不跳。
    let slot = NSView()
    let dot = NSView()
    dot.wantsLayer = true
    dot.layer?.cornerRadius = 4
    dot.layer?.backgroundColor = current ? NSColor.white.cgColor : nil
    dot.layer?.borderWidth = current ? 0 : 1
    dot.layer?.borderColor = NSColor.white.withAlphaComponent(0.4).cgColor
    dot.translatesAutoresizingMaskIntoConstraints = false
    slot.addSubview(dot)
    NSLayoutConstraint.activate([
      slot.widthAnchor.constraint(equalToConstant: 14),
      slot.heightAnchor.constraint(equalToConstant: 14),
      dot.widthAnchor.constraint(equalToConstant: 8),
      dot.heightAnchor.constraint(equalToConstant: 8),
      dot.centerXAnchor.constraint(equalTo: slot.centerXAnchor),
      dot.centerYAnchor.constraint(equalTo: slot.centerYAnchor),
    ])
    let name = NSTextField(labelWithString: label)
    name.font = .systemFont(ofSize: 13, weight: current ? .medium : .regular)
    name.textColor = current ? .white : NSColor.white.withAlphaComponent(0.45)
    setViews([slot, name], in: .leading)
    orientation = .horizontal
    alignment = .centerY
    spacing = 12
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// 一整块可点的选项：粗一点的标题加一行说明（同 web 的 `.auth-choice`）。
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

  /// `textWidth`：这一块的整宽，说明文字按它减掉两边留白和转圈的位置折行。
  init(title text: String, detail description: String, textWidth: CGFloat) {
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
    detail.preferredMaxLayoutWidth = textWidth - 32 - 28
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
