import AppKit

/// 原生几屏（首启、启动中、起不来）用的颜色，取自 web/src/styles/global.css 的浅 / 深两套令牌，
/// 换算成 sRGB。页面载进来之前和之后是同一张底色、同一种卡片，接上时不跳色。
/// 跟着系统外观翻面；页面那边用户另选了主题的话，以页面为准（窗口底色跟页面的 theme-color 走）。
enum AshPalette {
  static let chrome = color(light: 0xEFEFF0, dark: 0x151518)   // --chrome，= index.html 的 theme-color
  static let panel = color(light: 0xFFFFFF, dark: 0x202023)    // --panel，卡片
  static let raised = color(light: 0xF6F6F6, dark: 0x262729)   // --raised，卡片里的选项
  static let line = color(light: 0xE4E4E4, dark: 0x313134)     // --line
  static let ink = color(light: 0x1B1B1B, dark: 0xE8E8EA)      // --ink
  static let muted = color(light: 0x5C5C5E, dark: 0xA2A3A8)    // --muted
  static let faint = color(light: 0x9C9D9F, dark: 0x717277)    // --faint
  static let red = color(light: 0xD93D4C, dark: 0xEF6B7B)      // --red
  static let hover = color(light: 0xEDEDED, dark: 0x303033)    // ink 混进 panel 8%，同 `.auth-choice:hover`
  /// 首启欢迎窗左边那一栏：和图标同一块黑（深色下比 --chrome 再压一档，不至于和右边连成一片）。
  static let brand = color(light: 0x000000, dark: 0x0C0C0E)

  static func isDark(_ appearance: NSAppearance) -> Bool {
    appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
  }

  private static func color(light: UInt32, dark: UInt32) -> NSColor {
    NSColor(name: nil) { appearance in rgb(isDark(appearance) ? dark : light) }
  }

  private static func rgb(_ hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
  }
}
