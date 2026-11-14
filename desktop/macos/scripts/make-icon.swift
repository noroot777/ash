// 画 app 图标：纯黑圆角方块 + 白色小写 a。用法：swift make-icon.swift <输出的 .iconset 目录>
// 不入库位图，构建时现画，改样式只改这一份。
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                             samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                             colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let s = CGFloat(px)
  // macOS 图标网格：1024 画布里内容占 824，四周留 100 的边给阴影。
  let inset = s * 100 / 1024
  let body = NSRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
  let path = NSBezierPath(roundedRect: body, xRadius: body.width * 0.225, yRadius: body.width * 0.225)
  let shadow = NSShadow()
  shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
  shadow.shadowBlurRadius = s * 0.02
  shadow.shadowOffset = NSSize(width: 0, height: -s * 0.01)
  shadow.set()
  NSColor.black.setFill()
  path.fill()
  NSShadow().set()

  let font = NSFont.systemFont(ofSize: body.height * 0.62, weight: .semibold)
  let text = NSAttributedString(string: "a", attributes: [.font: font, .foregroundColor: NSColor.white])
  let size = text.size()
  // 按 x 高居中，而不是按行高：小写字母按行高放会偏下。draw(at:) 的点是行框左下角，基线在它上方 |descender| 处。
  let baseline = body.midY - font.xHeight / 2
  text.draw(at: NSPoint(x: body.midX - size.width / 2, y: baseline + font.descender))
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

for base in [16, 32, 128, 256, 512] {
  try render(base).write(to: out.appendingPathComponent("icon_\(base)x\(base).png"))
  try render(base * 2).write(to: out.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
