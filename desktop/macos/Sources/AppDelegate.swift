import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var windowController: BrowserWindowController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = MainMenu.build()
    let controller = BrowserWindowController()
    windowController = controller
    controller.showWindow(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  // 关窗不退出：ash 是常驻的工作台，像邮件 / Slack 那样点 Dock 图标就回来；⌘Q 才是真退出。
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { windowController?.showWindow(nil) }
    return true
  }

  func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }
}

/// 菜单不只是装饰：WKWebView 的 ⌘C / ⌘V / ⌘Z / ⌘A 全靠「编辑」菜单里的 responder 动作
/// 分发，少了它输入框里复制粘贴直接失灵。
enum MainMenu {
  static func build() -> NSMenu {
    let main = NSMenu()
    main.addItem(submenu(appMenu()))
    main.addItem(submenu(editMenu()))
    main.addItem(submenu(viewMenu()))
    main.addItem(submenu(historyMenu()))
    let window = windowMenu()
    main.addItem(submenu(window))
    NSApp.windowsMenu = window
    return main
  }

  private static func submenu(_ menu: NSMenu) -> NSMenuItem {
    let item = NSMenuItem()
    item.submenu = menu
    return item
  }

  private static func item(_ title: String, _ action: Selector?, _ key: String = "",
                           _ modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.keyEquivalentModifierMask = modifiers
    return item
  }

  private static func appMenu() -> NSMenu {
    let menu = NSMenu(title: "ash")
    menu.addItem(item("关于 ash", #selector(NSApplication.orderFrontStandardAboutPanel(_:))))
    menu.addItem(.separator())
    menu.addItem(item("隐藏 ash", #selector(NSApplication.hide(_:)), "h"))
    menu.addItem(item("隐藏其他", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
    menu.addItem(item("全部显示", #selector(NSApplication.unhideAllApplications(_:))))
    menu.addItem(.separator())
    menu.addItem(item("退出 ash", #selector(NSApplication.terminate(_:)), "q"))
    return menu
  }

  private static func editMenu() -> NSMenu {
    let menu = NSMenu(title: "编辑")
    menu.addItem(item("撤销", Selector(("undo:")), "z"))
    menu.addItem(item("重做", Selector(("redo:")), "z", [.command, .shift]))
    menu.addItem(.separator())
    menu.addItem(item("剪切", #selector(NSText.cut(_:)), "x"))
    menu.addItem(item("拷贝", #selector(NSText.copy(_:)), "c"))
    menu.addItem(item("粘贴", #selector(NSText.paste(_:)), "v"))
    menu.addItem(item("粘贴并匹配样式", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]))
    menu.addItem(item("全选", #selector(NSText.selectAll(_:)), "a"))
    return menu
  }

  private static func viewMenu() -> NSMenu {
    let menu = NSMenu(title: "显示")
    menu.addItem(item("重新载入", #selector(BrowserWindowController.reloadPage(_:)), "r"))
    menu.addItem(item("在浏览器中打开", #selector(BrowserWindowController.openInBrowser(_:)), "o", [.command, .shift]))
    menu.addItem(.separator())
    menu.addItem(item("实际大小", #selector(BrowserWindowController.resetZoom(_:)), "0"))
    menu.addItem(item("放大", #selector(BrowserWindowController.zoomIn(_:)), "="))
    menu.addItem(item("缩小", #selector(BrowserWindowController.zoomOut(_:)), "-"))
    menu.addItem(.separator())
    menu.addItem(item("进入全屏幕", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]))
    return menu
  }

  private static func historyMenu() -> NSMenu {
    let menu = NSMenu(title: "历史记录")
    menu.addItem(item("后退", #selector(BrowserWindowController.goBack(_:)), "["))
    menu.addItem(item("前进", #selector(BrowserWindowController.goForward(_:)), "]"))
    return menu
  }

  private static func windowMenu() -> NSMenu {
    let menu = NSMenu(title: "窗口")
    menu.addItem(item("最小化", #selector(NSWindow.performMiniaturize(_:)), "m"))
    menu.addItem(item("缩放", #selector(NSWindow.performZoom(_:))))
    menu.addItem(item("关闭窗口", #selector(NSWindow.performClose(_:)), "w"))
    return menu
  }
}
