// 画 app 图标：米白圆角方块 + ash 的点阵标。用法：swift make-icon.swift <输出的 .iconset 目录>
// 不入库位图，构建时现画，改样式只改这一份。
import AppKit

// 标本身：8×8 的一位图，# 是墨色，@ 是亮的那一格。这张图的出处是 web/src/brand/ashMark.ts，
// Swift 够不着那边，这里是照着抄的 —— 改标的时候两处一起改（docs/logo/icon.svg 是同一张图，可以对着看）。
let mark = [
  ".......@",
  "....#...",
  "..#...#.",
  "#..#.#..",
  "###.#...",
  "####..#.",
  "#####...",
  "#####.#.",
]
func gray(_ hex: Int) -> NSColor {
  NSColor(deviceRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
          blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}

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
  gray(0xeceae4).setFill()
  path.fill()
  NSShadow().set()

  // 与 docs/logo/icon.svg 同一个比例：512 的底上一格 40，标占正中 320。格子和起点都取整到像素：
  // 不取整的话相邻两格各自抗锯齿，中间会留一道发灰的缝，小尺寸上整张标是糊的。AppKit 的 y 朝上，行要倒着放。
  let cell = max(1, (body.width * 40 / 512).rounded())
  let left = (body.midX - cell * 4).rounded()
  let top = (body.midY + cell * 4).rounded()
  for (row, line) in mark.enumerated() {
    for (col, dot) in line.enumerated() where dot != "." {
      gray(dot == "@" ? 0x5e6ad2 : 0x111113).setFill()
      NSRect(x: left + CGFloat(col) * cell, y: top - CGFloat(row + 1) * cell, width: cell, height: cell).fill()
    }
  }
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

for base in [16, 32, 128, 256, 512] {
  try render(base).write(to: out.appendingPathComponent("icon_\(base)x\(base).png"))
  try render(base * 2).write(to: out.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
