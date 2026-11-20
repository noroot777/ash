import AppKit

/// 菜单里「允许其他设备访问」那一项：改 `NaviConfig.allowsOtherDevices`，再让自己那份服务按新设置重起。
///
/// 服务听在哪、远程配对开不开，是起服务那一下由 `NAVI_LOCAL_ONLY` 定的（ServerLauncher），所以光改
/// 设置不够，得重启。重启用的是装更新那一套零件，只是不备份库、不换代码：先问会打断谁
/// （RestartImpact），会打断或者确认不了就摆给用户、让他选；放行后攥住维护锁（这期间登录项、别的窗口
/// 都不许起服务，见 Maintenance），只停评估过的那一份（ServerShutdown），松锁后窗口照常 loadHome，
/// ServerLauncher 按新设置起一份。服务本来没在跑、端口上是别的 navi：只记下设置，下次起服务时生效。
/// 没停成就把设置改回去，免得菜单上的勾跟在跑的服务对不上。只在主线程上用。
enum RemoteAccessSwitch {
  private(set) static var busy = false

  static func toggle(_ controller: BrowserWindowController?) {
    guard !busy else { return }
    if let note = ServerLauncher.shared.hold {
      alert("现在改不了", "\(note)。等它完了再改。")
      return
    }
    busy = true
    let enable = !NaviConfig.allowsOtherDevices
    DispatchQueue.global(qos: .userInitiated).async {
      let verdict = RestartImpactProbe.assessSync()
      DispatchQueue.main.async {
        guard confirm(enable: enable, verdict: verdict, window: controller?.window) else {
          busy = false
          return
        }
        apply(enable: enable, verdict: verdict, controller: controller)
      }
    }
  }

  private static func confirm(enable: Bool, verdict: ImpactVerdict, window: NSWindow?) -> Bool {
    // 改回只听本机是收窄，不打断谁就直接办。
    guard enable || verdict.needsConsent else { return true }
    let alert = NSAlert()
    var lines: [String] = []
    if enable {
      alert.messageText = "允许其他设备访问这台 Navi？"
      lines.append("服务不再只听 127.0.0.1：同一 Tailscale 或局域网里的设备连得上 \(NaviConfig.port) 端口，"
        + "进来仍要在这台电脑上批准配对，或者输入访问密钥（设置 › 默认规则 › 远程访问）。"
        + "手机上点飞书卡片的「在 Navi 中打开」也就打得开了。")
      lines.append("macOS 防火墙开着的话，会问一次要不要让 node 接受传入连接，选「允许」。")
      alert.addButton(withTitle: "打开并重启服务")
    } else {
      alert.messageText = "改回只允许本机访问？"
      alert.addButton(withTitle: "重启服务")
    }
    alert.addButton(withTitle: "取消")
    switch verdict {
    case .clear: lines.append("要重启 Navi 服务才生效，几秒钟就好；在跑的任务照常接着跑。")
    case .disrupts(_, let items):
      let shown = items.prefix(8).map { "· \($0.title) —— \($0.why)" }
      let more = items.count > shown.count ? ["…另有 \(items.count - shown.count) 个"] : []
      lines.append((["要重启 Navi 服务才生效，现在重启会打断："] + shown + more).joined(separator: "\n"))
    case .unknown(let why):
      lines.append("要重启 Navi 服务才生效。确认不了重启会不会打断任务（\(why)），按会打断对待。")
    }
    alert.informativeText = lines.joined(separator: "\n\n")
    return alert.runModal() == .alertFirstButtonReturn
  }

  private static func apply(enable: Bool, verdict: ImpactVerdict, controller: BrowserWindowController?) {
    let note = "正在按新设置重启 Navi 服务…"
    NaviConfig.allowsOtherDevices = enable
    controller?.showInstalling(note, detail: "接管得了的任务照常在跑，服务起来后自动接上。")
    DispatchQueue.global(qos: .userInitiated).async {
      var failure: String?
      do {
        let maintenance = try Maintenance.begin(note: note, timeout: 50)
        switch ServerShutdown.stop(expecting: verdict.target) {
        case .stopped: break
        case .changed(let why): failure = "评估之后端口上的服务变了（\(why)），这次没有重启。"
        case .failed(let why): failure = why
        }
        maintenance.end()
      } catch {
        failure = "没能让服务下线：\(error.localizedDescription)"
      }
      DispatchQueue.main.async {
        busy = false
        if let failure {
          NaviConfig.allowsOtherDevices = !enable
          alert("没有切换", "\(failure)\n\n设置没改，可以再试一次。")
        }
        controller?.loadHome()
      }
    }
  }

  private static func alert(_ title: String, _ detail: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = detail
    alert.addButton(withTitle: "好")
    alert.runModal()
  }
}
