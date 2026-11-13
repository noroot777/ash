import AppKit
import os

/// 换代码之前的那道闸：装新版 app = 重启它里面的服务。先问 server「现在重启会打断谁」
/// （RestartImpact），没人会被打断就直接换；会打断就把是谁、几个摆给用户，让他选「等它们跑完」
/// 还是「现在」。放行之后：先停自己那份服务，再备份库（新版一起来就迁移），最后才交给调用方
/// 去换（Sparkle 的安装回调）。
///
/// 两种来由：
///  · `.update`       Sparkle 下好了新版、要装了（装完重开 / 退出时装）
///  · `.staleServer`  app 已经是新版，端口上那份服务却还是旧版 app 起的（见 ServerRecord）——
///                    比如 `build.sh --install`、或者退出时装的那一档没走到这道闸。闸放行后停掉它，
///                    窗口重连时用新版起一份。
///
/// 停服务到 Sparkle 换完 app 之间，ServerLauncher 被 hold 住：窗口的探活发现服务不在也不会拿
/// 旧代码再起一份。只在主线程上用。
final class UpdateGate {
  enum Purpose {
    case update(version: String)
    case staleServer(from: String)
  }

  enum Choice { case wait, now, cancel }

  struct Prompt {
    let title: String
    let detail: String
    /// 第一个是默认（回车）。顺序与 `choices` 一一对应。
    let buttons: [String]
    let choices: [Choice]
  }

  enum Phase { case idle, checking, waiting, preparing, prepared }

  static let shared = UpdateGate()

  /// 怎么问用户。缺省弹 NSAlert；回归测试换成照脚本作答。
  var ask: (Prompt) -> Choice = UpdateGate.runAlert
  /// 出错时怎么告诉用户（退出那一档另有按钮，见 `requestForQuit`）。
  var report: (String) -> Void = { _ = UpdateGate.runAlert(Prompt(title: "更新没装上", detail: $0, buttons: ["好"], choices: [.cancel])) }
  /// 闸关上（非 nil：正在换代码，窗口盖上这句话）/ 打开（nil：窗口重新连，需要时起服务）。
  var onHoldChanged: ((String?) -> Void)?
  /// 阶段变了（菜单里「安装更新」那一项跟着变）。
  var onPhaseChanged: (() -> Void)?
  var pollInterval: TimeInterval = 5
  var shutdownTimeout: TimeInterval = 20

  private(set) var phase: Phase = .idle { didSet { onPhaseChanged?() } }
  private var purpose: Purpose?
  private var proceeds: [() -> Void] = []
  private var quitReplies: [(Bool) -> Void] = []
  private var pollTimer: Timer?
  private var polling = false

  /// 有一次换代码在排着（在等任务跑完，或者上一次没装成、等用户再点）。
  var hasPending: Bool { !proceeds.isEmpty && phase != .preparing && phase != .prepared }

  /// 「可以换代码了吗」。放行后（服务已停、库已备份）调 proceed。已经放行过就直接调。
  func request(_ purpose: Purpose, proceed: @escaping () -> Void) {
    if phase == .prepared { proceed(); return }
    if case .update = purpose { self.purpose = purpose } else if self.purpose == nil { self.purpose = purpose }
    proceeds.append(proceed)
    if phase == .idle { evaluate(quitting: false) }
  }

  /// 菜单里那一项：在等的时候重新问一遍（「现在装」的入口），没装成的时候再试一次。
  func reconsider() {
    guard hasPending, phase == .waiting || phase == .idle else { return }
    stopPolling()
    evaluate(quitting: false)
  }

  /// 用户要退出，而退出时 Sparkle 会把下好的更新装上：同一道闸，多一个「取消」。
  /// reply(true) = 可以退了；reply(false) = 这次别退。选了「等它们跑完」时，等完调 whenDrained。
  func requestForQuit(version: String, whenDrained: @escaping () -> Void, reply: @escaping (Bool) -> Void) {
    switch phase {
    case .prepared: reply(true); return
    case .preparing: quitReplies.append(reply); return
    default: break
    }
    if purpose == nil { purpose = .update(version: version) }
    let waitingBefore = phase == .waiting
    stopPolling()
    phase = .checking
    assess { [self] verdict in
      guard verdict.needsConsent else {
        quitReplies.append(reply)
        prepare()
        return
      }
      switch ask(prompt(for: verdict, quitting: true)) {
      case .now:
        quitReplies.append(reply)
        prepare()
      case .wait:
        reply(false)
        if proceeds.isEmpty { proceeds.append(whenDrained) }
        startWaiting()
      case .cancel:
        reply(false)
        if waitingBefore { startWaiting() } else { phase = .idle }
      }
    }
  }

  // MARK: 内部

  private func evaluate(quitting: Bool) {
    phase = .checking
    assess { [self] verdict in
      guard verdict.needsConsent else { prepare(); return }
      switch ask(prompt(for: verdict, quitting: quitting)) {
      case .now: prepare()
      case .wait, .cancel: startWaiting()
      }
    }
  }

  private func assess(_ completion: @escaping (ImpactVerdict) -> Void) {
    DispatchQueue.global(qos: .userInitiated).async {
      let verdict = RestartImpactProbe.assessSync()
      DispatchQueue.main.async { completion(verdict) }
    }
  }

  private func startWaiting() {
    phase = .waiting
    log("等会被打断的任务跑完，每 \(Int(pollInterval)) 秒再问一次")
    pollTimer?.invalidate()
    pollTimer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
      guard let self, !self.polling, self.phase == .waiting else { return }
      self.polling = true
      self.assess { verdict in
        self.polling = false
        if self.phase == .waiting && !verdict.needsConsent { self.prepare() }
      }
    }
  }

  private func stopPolling() {
    pollTimer?.invalidate()
    pollTimer = nil
  }

  private func prepare() {
    guard phase != .preparing && phase != .prepared else { return }
    stopPolling()
    phase = .preparing
    let stale: String? = { if case .staleServer(let from) = purpose { return from } else { return nil } }()
    let note = stale == nil ? "正在安装更新…" : "正在换成新版的 ash 服务…"
    ServerLauncher.shared.hold = note
    onHoldChanged?(note)
    log("放行：停服务、备份库")
    DispatchQueue.global(qos: .userInitiated).async { [self] in
      var failure: String?
      switch ServerShutdown.stopOurs(timeout: shutdownTimeout) {
      case .failed(let reason):
        failure = reason
      case .stopped(let pid):
        log("服务已下线（进程 \(pid.map(String.init) ?? "本来就不在")）")
        do {
          let backup = try DatabaseBackup.beforeUpdate(fromVersion: stale ?? AshConfig.bundleVersion)
          log("库已备份：\(backup?.path ?? "数据根里还没有库，不用备份")")
        } catch {
          failure = "更新前备份库没成功（\(error.localizedDescription)），更新没装。"
        }
      }
      DispatchQueue.main.async {
        if let failure { self.fail(failure) } else { self.finish(stale: stale != nil) }
      }
    }
  }

  private func finish(stale: Bool) {
    let run = proceeds
    let replies = quitReplies
    proceeds = []
    quitReplies = []
    if stale {
      // 服务换代码这件事到这儿就完了：放开闸，窗口重连时用新版起服务。
      purpose = nil
      phase = .idle
      ServerLauncher.shared.hold = nil
      onHoldChanged?(nil)
    } else {
      // 停在这里，直到 Sparkle 换完 app、把这个进程退掉（不放开闸：放开就会拿旧代码再起一份）。
      phase = .prepared
    }
    run.forEach { $0() }
    replies.forEach { $0(true) }
  }

  private func fail(_ reason: String) {
    log("没装成：\(reason)")
    phase = .idle
    ServerLauncher.shared.hold = nil
    onHoldChanged?(nil)
    let replies = quitReplies
    quitReplies = []
    if replies.isEmpty {
      report(reason)
      return
    }
    // 要退出的那一档不能把人困住：备份一直不成功（比如盘满了）时总得退得掉。
    let choice = ask(Prompt(title: "更新没装上", detail: "\(reason)\n\n仍然退出的话，Sparkle 照样会在退出时装上新版。",
                            buttons: ["不退出", "仍然退出"], choices: [.cancel, .now]))
    replies.forEach { $0(choice == .now) }
  }

  private func prompt(for verdict: ImpactVerdict, quitting: Bool) -> Prompt {
    let title: String
    var lines: [String] = []
    let (waitTitle, nowTitle): (String, String)
    switch purpose {
    case .staleServer(let from):
      title = "ash 服务还在跑旧版（\(from)）"
      lines.append("app 已经是新版，换上新版的服务要重启它。")
      (waitTitle, nowTitle) = ("等它们跑完再重启", "现在重启")
    case .update(let version):
      title = "装新版 \(version) 要重启 ash 服务"
      (waitTitle, nowTitle) = ("等它们跑完再装", "现在装")
    case nil:
      title = "装新版要重启 ash 服务"
      (waitTitle, nowTitle) = ("等它们跑完再装", "现在装")
    }
    if quitting { lines.append("退出 ash 时 Sparkle 会把下好的新版装上。") }
    switch verdict {
    case .disrupts(let items):
      lines.append("会打断 \(items.count) 个任务：")
      lines += items.prefix(8).map { "· \($0.title) —— \($0.why)" }
      if items.count > 8 { lines.append("……还有 \(items.count - 8) 个") }
    case .unknown(let why):
      lines.append("问不出重启会打断哪些任务（\(why)）。问不出来不等于没有。")
    case .clear:
      break
    }
    log("问用户：\(title)；\(lines.joined(separator: " "))")
    var buttons = [waitTitle, nowTitle]
    var choices: [Choice] = [.wait, .now]
    if quitting {
      buttons.append("取消")
      choices.append(.cancel)
    }
    return Prompt(title: title, detail: lines.joined(separator: "\n"), buttons: buttons, choices: choices)
  }

  private static func runAlert(_ prompt: Prompt) -> Choice {
    let alert = NSAlert()
    alert.messageText = prompt.title
    alert.informativeText = prompt.detail
    for title in prompt.buttons { alert.addButton(withTitle: title) }
    NSApp.activate(ignoringOtherApps: true)
    let index = alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
    return prompt.choices.indices.contains(index) ? prompt.choices[index] : .cancel
  }

  /// 记进系统日志（Console.app 里按子系统 = bundle id、类别 update 过滤）：事后查「为什么没装 / 为什么问了」。
  static let logger = Logger(subsystem: AshConfig.bundleID, category: "update")

  private func log(_ message: String) {
    Self.logger.notice("\(message, privacy: .public)")
  }
}
