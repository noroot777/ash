// 把 SVG 画成 PNG：swift rasterize.swift <输入.svg> <输出.png> <边长像素> [<输入.svg> <输出.png> <边长像素> ...]
// docs/logo/build.mjs 用它出手机端那几张位图。SVG 交给 AppKit 自己解析（NSImage 认 SVG），不另装渲染器。
import AppKit

let args = Array(CommandLine.arguments.dropFirst())
guard !args.isEmpty, args.count % 3 == 0 else {
  FileHandle.standardError.write("用法：swift rasterize.swift <输入.svg> <输出.png> <边长像素> ...\n".data(using: .utf8)!)
  exit(2)
}

for i in stride(from: 0, to: args.count, by: 3) {
  let source = URL(fileURLWithPath: args[i])
  guard let image = NSImage(contentsOf: source), let px = Int(args[i + 2]) else {
    FileHandle.standardError.write("读不了 \(args[i])\n".data(using: .utf8)!)
    exit(1)
  }
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                             samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                             colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  image.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
  NSGraphicsContext.restoreGraphicsState()
  try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[i + 1]))
}
