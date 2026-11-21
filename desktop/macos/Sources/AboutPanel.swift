import AppKit

final class AboutPanel: NSObject {
  static let shared = AboutPanel()

  @objc func show(_ sender: Any?) {
    NSApp.orderFrontStandardAboutPanel(options: [.version: ""])
  }
}
