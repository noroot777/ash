// 画 app 图标：把 docs/logo/icon.svg（米白圆角块 + navi 的标）摆进 macOS 图标网格，底下垫一层阴影。
// 用法：swift make-icon.swift <icon.svg> <输出的 .iconset 目录>
// 标本身不在这里画：icon.svg 是 docs/logo/build.mjs 从 web/src/brand/naviMark.ts 生成的，改标只改那一份。
// SVG 交给 AppKit 解析；它不认 CSS 变量，所以 icon.svg 的颜色是直接写在属性里的。
import AppKit

guard CommandLine.arguments.count == 3, let icon = NSImage(contentsOfFile: CommandLine.arguments[1]) else {
  FileHandle.standardError.write("用法：swift make-icon.swift <icon.svg> <输出的 .iconset 目录>\n".data(using: .utf8)!)
  exit(2)
}
let out = URL(fileURLWithPath: CommandLine.arguments[2])
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
  let shadow = NSShadow()
  shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
  shadow.shadowBlurRadius = s * 0.02
  shadow.shadowOffset = NSSize(width: 0, height: -s * 0.01)
  shadow.set()
  icon.draw(in: body)
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

for base in [16, 32, 128, 256, 512] {
  try render(base).write(to: out.appendingPathComponent("icon_\(base)x\(base).png"))
  try render(base * 2).write(to: out.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
