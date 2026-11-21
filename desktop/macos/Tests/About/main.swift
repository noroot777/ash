import AppKit

func visibleText(in view: NSView) -> [String] {
  var text: [String] = []
  if let field = view as? NSTextField { text.append(field.stringValue) }
  if let editor = view as? NSTextView { text.append(editor.string) }
  return text + view.subviews.flatMap { visibleText(in: $0) }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let actionSent = application.sendAction(#selector(AboutPanel.show(_:)), to: AboutPanel.shared, from: nil)
RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.2))
let panels = application.windows.filter { $0.isVisible }
let text = panels.compactMap(\.contentView).flatMap { visibleText(in: $0) }
let result: [String: Any] = [
  "actionSent": actionSent,
  "text": text,
  "buildNumber": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
  "shortVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
]
let arguments = CommandLine.arguments
if arguments.count > 2, let content = panels.first?.contentView,
   let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) {
  content.cacheDisplay(in: content.bounds, to: bitmap)
  let snapshot = NSImage(size: content.bounds.size)
  snapshot.lockFocus()
  NSColor.windowBackgroundColor.setFill()
  NSBezierPath(rect: content.bounds).fill()
  bitmap.draw(in: content.bounds, from: NSRect(origin: .zero, size: bitmap.size),
              operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
  snapshot.unlockFocus()
  if let data = snapshot.tiffRepresentation, let image = NSBitmapImageRep(data: data) {
    try image.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: arguments[2]))
  }
}
try JSONSerialization.data(withJSONObject: result).write(to: URL(fileURLWithPath: arguments[1]))
panels.forEach { $0.orderOut(nil) }
