import AppKit
import WebKit

@main
struct TerminalWebViewProbe {
  static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.finishLaunching()
    let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1100, height: 850),
      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Navi Terminal Probe"
    let view = NaviWebView(frame: window.contentLayoutRect)
    view.configuration.userContentController.addUserScript(WKUserScript(source: """
      window.probeEvents = [];
      window.probeErrors = [];
      window.addEventListener('error', event => probeErrors.push(event.error?.stack ?? event.message));
      const OriginalEventSource = window.EventSource;
      window.EventSource = class extends OriginalEventSource {
        constructor(url, options) {
          super(url, options);
          probeEvents.push('connect: ' + url);
          for (const type of ['open', 'error', 'message']) this.addEventListener(type, event =>
            probeEvents.push(type + ': ' + (event.data ? JSON.parse(event.data).seq : this.readyState)));
        }
      };
      """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    window.contentView = view
    window.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
    defer { window.orderOut(nil) }

    func spin() {
      while let event = app.nextEvent(matching: .any, until: Date(), inMode: .default, dequeue: true) {
        app.sendEvent(event)
      }
      app.updateWindows()
      RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }

    func js(_ source: String) -> String {
      var answer: String?
      view.evaluateJavaScript(source) { value, error in
        answer = error.map { "ERROR: \($0.localizedDescription)" } ?? String(describing: value ?? "")
      }
      let deadline = Date().addingTimeInterval(5)
      while answer == nil && Date() < deadline { spin() }
      return answer ?? "ERROR: JavaScript timed out"
    }
    func wait(_ description: String, _ predicate: () -> Bool) {
      let deadline = Date().addingTimeInterval(20)
      while Date() < deadline {
        if predicate() { return }
        spin()
      }
      fputs("FAIL: \(description)\n\(js("document.body.innerText"))\n\(js("JSON.stringify({ events: probeEvents, errors: probeErrors, visibility: document.visibilityState })"))\n", stderr)
      exit(1)
    }
    func key(_ characters: String, code: UInt16, modifiers: NSEvent.ModifierFlags = []) {
      for eventType in [NSEvent.EventType.keyDown, .keyUp] {
        let event = NSEvent.keyEvent(with: eventType, location: .zero, modifierFlags: modifiers,
          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
          characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)!
        app.sendEvent(event)
      }
      spin()
    }
    func type(_ text: String) {
      let codes: [Character: UInt16] = ["a": 0, "s": 1, "d": 2, "c": 8, "e": 14, "g": 5, "i": 34,
        "l": 37, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15, "t": 17, "v": 9,
        "w": 13, "x": 7, "-": 27, ":": 41, "0": 29]
      for character in text {
        let lower = Character(String(character).lowercased())
        guard let code = codes[lower] else { fatalError("No probe key code for \(character)") }
        let shifted = character == ":" || character != lower
        key(String(character), code: code, modifiers: shifted ? .shift : [])
      }
    }
    func capture(_ path: String) {
      var captured = false
      view.takeSnapshot(with: WKSnapshotConfiguration()) { image, error in
        if let image, let tiff = image.tiffRepresentation,
           let bitmap = NSBitmapImageRep(data: tiff), let data = bitmap.representation(using: .png, properties: [:]) {
          do { try data.write(to: URL(fileURLWithPath: path)); captured = true }
          catch { fputs("Snapshot failed: \(error)\n", stderr) }
        }
      }
      wait("native snapshot") { captured }
    }
    func announce(_ message: String) { print(message); fflush(stdout) }
    let screen = "document.querySelector('.project-terminal__viewport:not([hidden]) .xterm-rows')?.innerText ?? ''"
    view.load(URLRequest(url: URL(string: CommandLine.arguments[1])!))
    wait("fixture loaded") { js("String(!!document.querySelector('button'))") == "true" }
    _ = js("document.querySelector('button').click(); true")
    wait("terminal prompt") { js(screen).contains("%") }
    announce("NATIVE_SHELL_READY")
    wait("vi initial screen") { js(screen).contains("~") }
    window.makeFirstResponder(view)
    _ = js("document.querySelector('.xterm-helper-textarea').focus(); true")
    announce("NATIVE_VI_READY")
    type("inative-vi-linX")
    key("\u{7f}", code: 51)
    type("e")
    key("\u{f702}", code: 123, modifiers: .function)
    key("\u{f703}", code: 124, modifiers: .function)
    key("\r", code: 36)
    type("second-line")
    key("\u{1b}", code: 53)
    wait("vi live editing rendered") { js(screen).contains("native-vi-line") && js(screen).contains("second-line") }
    wait("vi normal mode") { !js(screen).contains("-- INSERT --") }
    type("gg0itop-")
    key("\u{1b}", code: 53)
    wait("vi first line edited") { js(screen).contains("top-native-vi-line") && !js(screen).contains("-- INSERT --") }
    capture(CommandLine.arguments[2] + "-vi.png")
    announce("NATIVE_EDIT_READY")
    type(":wq")
    key("\r", code: 36)
    wait("shell prompt restored") { js(screen).contains("%") && !js(screen).contains("second-line") }
    announce("NATIVE_SHELL_RESTORED")
    wait("shell restored") { js(screen).contains("__NATIVE_DONE__") }
    capture(CommandLine.arguments[2])
    wait("no native JavaScript errors") { js("JSON.stringify(probeErrors)") == "[]" }
    announce("PASS: native WKWebView vi typing, arrows, backspace, Escape, navigation, save and shell restoration")
  }
}
