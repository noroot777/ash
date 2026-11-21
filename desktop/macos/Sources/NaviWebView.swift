import AppKit
import WebKit

class NaviWebView: WKWebView {
  private var forwardingMouseEvent = false

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override var inputContext: NSTextInputContext? {
    forwardingMouseEvent ? nil : super.inputContext
  }

  private func routeMouseEvent(_ event: NSEvent, forward: () -> Void) {
    if inputContext?.handleEvent(event) == true { return }
    forwardingMouseEvent = true
    defer { forwardingMouseEvent = false }
    forward()
  }

  override func mouseDown(with event: NSEvent) {
    routeMouseEvent(event) { super.mouseDown(with: event) }
  }

  override func mouseUp(with event: NSEvent) {
    routeMouseEvent(event) { super.mouseUp(with: event) }
  }

  override func mouseMoved(with event: NSEvent) {
    routeMouseEvent(event) { super.mouseMoved(with: event) }
  }

  override func mouseEntered(with event: NSEvent) {
    routeMouseEvent(event) { super.mouseEntered(with: event) }
  }

  override func mouseExited(with event: NSEvent) {
    routeMouseEvent(event) { super.mouseExited(with: event) }
  }

  override func mouseDragged(with event: NSEvent) {
    routeMouseEvent(event) { super.mouseDragged(with: event) }
  }

  override func rightMouseDown(with event: NSEvent) {
    routeMouseEvent(event) { super.rightMouseDown(with: event) }
  }

  override func rightMouseUp(with event: NSEvent) {
    routeMouseEvent(event) { super.rightMouseUp(with: event) }
  }

  override func rightMouseDragged(with event: NSEvent) {
    routeMouseEvent(event) { super.rightMouseDragged(with: event) }
  }

  override func otherMouseDown(with event: NSEvent) {
    routeMouseEvent(event) { super.otherMouseDown(with: event) }
  }

  override func otherMouseUp(with event: NSEvent) {
    routeMouseEvent(event) { super.otherMouseUp(with: event) }
  }

  override func otherMouseDragged(with event: NSEvent) {
    routeMouseEvent(event) { super.otherMouseDragged(with: event) }
  }
}
