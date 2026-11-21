import AppKit
import WebKit

final class NaviWebView: WKWebView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
