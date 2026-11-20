import AppKit
import Sparkle

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var windowController: BrowserWindowController?
  /// 窗口建出来之前就收到的 navi:// 链接（被链接拉起时，系统可能先递链接、后报启动完成）。
  private var pendingLinks: [URL] = []

  func applicationDidFinishLaunching(_ notification: Notification) {
    // 第一个 WKWebView 建出来之前：要先让旧 app 退出、把改名前的网页数据复制过来（见 LegacyIdentity）。
    guard adoptLegacyIdentity() else { return }
    AppUpdater.shared.start()
    NSApp.mainMenu = MainMenu.build()
    let controller = BrowserWindowController()
    windowController = controller
    UpdateGate.shared.onHoldChanged = { [weak controller] note in
      if let note { controller?.showInstalling(note) } else { controller?.loadHome() }
    }
    controller.showWindow(nil)
    NSApp.activate(ignoringOtherApps: true)
    pendingLinks.forEach(controller.open(link:))
    pendingLinks = []
    do { try LoginService.reconcileAtLaunch() } catch { NSAlert(error: error).runModal() }
    DispatchQueue.global(qos: .utility).async { DownloadTransaction.reclaimAbandoned() }
  }

  /// 网页数据没接过来就不建窗口（建了就再也接不回来，见 LegacyIdentity.webDataSettled）：说清卡在哪，让用户选。
  /// 返回 false = 用户选了退出。
  private func adoptLegacyIdentity() -> Bool {
    while let blocked = LegacyIdentity.adoptAtLaunch() {
      let alert = NSAlert()
      alert.messageText = "还没接过 Ash 的登录和页面设置"
      alert.informativeText = "\(blocked)\n\n现在不接直接打开的话，Ash 里的登录、草稿和页面设置就不再接过来了（Ash 那份原样留着）。"
      alert.addButton(withTitle: "重试")
      alert.addButton(withTitle: "不接了，直接打开")
      alert.addButton(withTitle: "退出")
      switch alert.runModal() {
      case .alertFirstButtonReturn: continue
      case .alertSecondButtonReturn:
        // 记不下（另一份 Navi 还在复制）就不开窗口，回到上面重新判断、再问一次。
        _ = LegacyIdentity.skipWebData()
      default:
        NSApp.terminate(nil)
        return false
      }
    }
    return true
  }

  /// 退出时 Sparkle 会把下好的新版装上：先过 UpdateGate（会不会打断任务、停服务、备份库）。
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard let version = AppUpdater.shared.readyVersion, UpdateGate.shared.phase != .prepared else { return .terminateNow }
    UpdateGate.shared.requestForQuit(version: version, whenDrained: { NSApp.terminate(nil) }) { allowed in
      NSApp.reply(toApplicationShouldTerminate: allowed)
    }
    return .terminateLater
  }

  @objc func installPendingUpdate(_ sender: Any?) {
    UpdateGate.shared.reconsider()
  }

  // 关窗不退出：navi 是常驻的工作台，像邮件 / Slack 那样点 Dock 图标就回来；⌘Q 才是真退出。
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { windowController?.showWindow(nil) }
    return true
  }

  func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

  /// navi:// 链接（DeepLink）。
  func application(_ application: NSApplication, open urls: [URL]) {
    guard let controller = windowController else {
      pendingLinks.append(contentsOf: urls)
      return
    }
    urls.forEach(controller.open(link:))
  }

  @objc func toggleOtherDevices(_ sender: NSMenuItem) {
    RemoteAccessSwitch.toggle(windowController)
  }

  @objc func checkHostMcp(_ sender: Any?) {
    HostMcpSetup.check(window: windowController?.window)
  }

  @objc func toggleLoginService(_ sender: NSMenuItem) {
    do {
      try LoginService.setEnabled(!LoginService.isEnabled)
    } catch {
      NSAlert(error: error).runModal()
    }
  }
}

extension AppDelegate: NSMenuItemValidation {
  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    if item.action == #selector(toggleLoginService(_:)) {
      item.state = LoginService.isEnabled ? .on : .off
    }
    // 只有本机那份才有「让不让别的设备进来」这回事：连别处的 navi 时 app 只是个窗口。
    if item.action == #selector(toggleOtherDevices(_:)) {
      item.state = NaviConfig.allowsOtherDevices ? .on : .off
      // 在跑的服务没按这个勾起（ServedInstance）：如实写出来，点它就是按勾重启。
      item.title = ServedInstance.networkPending ? "允许其他设备访问（重启服务后生效）" : "允许其他设备访问"
      return NaviConfig.isLocal && !RemoteAccessSwitch.busy
    }
    // 只有本机那份才有「替这台机器的 CLI 接 MCP」这回事。
    if item.action == #selector(checkHostMcp(_:)) { return NaviConfig.isLocal }
    // 只在有一次更新排着（等任务跑完、或上次没装成）时出现。
    if item.action == #selector(installPendingUpdate(_:)) {
      let gate = UpdateGate.shared
      item.isHidden = !gate.hasPending
      item.title = gate.phase == .waiting ? "等任务跑完后安装更新…" : "安装更新…"
      return gate.hasPending
    }
    return true
  }
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
    let menu = NSMenu(title: "Navi")
    menu.addItem(item("关于 Navi", #selector(NSApplication.orderFrontStandardAboutPanel(_:))))
    if let target = AppUpdater.shared.menuTarget {
      let check = item("检查更新…", #selector(SPUStandardUpdaterController.checkForUpdates(_:)))
      check.target = target
      menu.addItem(check)
      let pending = item("安装更新…", #selector(AppDelegate.installPendingUpdate(_:)))
      pending.isHidden = true
      menu.addItem(pending)
    }
    menu.addItem(.separator())
    menu.addItem(item("登录时启动 Navi 服务", #selector(AppDelegate.toggleLoginService(_:))))
    menu.addItem(item("允许其他设备访问", #selector(AppDelegate.toggleOtherDevices(_:))))
    menu.addItem(item("检查 Navi MCP 登记…", #selector(AppDelegate.checkHostMcp(_:))))
    menu.addItem(.separator())
    menu.addItem(item("隐藏 Navi", #selector(NSApplication.hide(_:)), "h"))
    menu.addItem(item("隐藏其他", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
    menu.addItem(item("全部显示", #selector(NSApplication.unhideAllApplications(_:))))
    menu.addItem(.separator())
    menu.addItem(item("退出 Navi", #selector(NSApplication.terminate(_:)), "q"))
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
