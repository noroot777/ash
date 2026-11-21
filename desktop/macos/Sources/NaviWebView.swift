import AppKit
import WebKit

class NaviWebView: WKWebView {
  private var forwardingMouseGesture = false

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override var inputContext: NSTextInputContext? {
    forwardingMouseGesture ? nil : super.inputContext
  }

  private func routeMouseGesture(_ event: NSEvent, forward: () -> Void) {
    if inputContext?.handleEvent(event) == true { return }
    let wasForwarding = forwardingMouseGesture
    forwardingMouseGesture = true
    defer { forwardingMouseGesture = wasForwarding }
    forward()
  }

  override func mouseDown(with event: NSEvent) {
    routeMouseGesture(event) { super.mouseDown(with: event) }
  }

  override func mouseUp(with event: NSEvent) {
    routeMouseGesture(event) { super.mouseUp(with: event) }
  }

  override func mouseDragged(with event: NSEvent) {
    routeMouseGesture(event) { super.mouseDragged(with: event) }
  }

  override func rightMouseDown(with event: NSEvent) {
    routeMouseGesture(event) { super.rightMouseDown(with: event) }
  }

  override func rightMouseUp(with event: NSEvent) {
    routeMouseGesture(event) { super.rightMouseUp(with: event) }
  }

  override func rightMouseDragged(with event: NSEvent) {
    routeMouseGesture(event) { super.rightMouseDragged(with: event) }
  }

  override func otherMouseDown(with event: NSEvent) {
    routeMouseGesture(event) { super.otherMouseDown(with: event) }
  }

  override func otherMouseUp(with event: NSEvent) {
    routeMouseGesture(event) { super.otherMouseUp(with: event) }
  }

  override func otherMouseDragged(with event: NSEvent) {
    routeMouseGesture(event) { super.otherMouseDragged(with: event) }
  }
}
