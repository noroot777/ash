import AppKit
import os

/// 外置运行时把换 app 与换服务分开：Sparkle 只换窗口，旧服务和 MCP 继续用原来的版本。
/// 新窗口接管服务时先备份并取得起跑闸门；不可接管的当前回合继续由旧服务运行。
/// 尚未迁出的旧布局沿用原先的确认、停服务、备份流程。
///
/// 两种来由：
///  · `.update`       Sparkle 下好了新版、要装了（装完重开 / 退出时装）
///  · `.staleServer`  app 已经是新版，端口上那份服务却还是旧版 app 起的（见 ServerRecord）——
///                    比如 `build.sh --install`、或者退出时装的那一档没走到这道闸。闸放行后停掉它，
///                    窗口重连时用新版起一份。
///
/// Sparkle 放弃了这次更新（`abandon`）：排着的安装回调、轮询、已经攥着的维护锁全部作废，窗口
/// 重连、服务照常起；下一次再要装从头评估、再备份一次。发出去还没回来的评估 / 停服务靠代际号
/// （`epoch`）认出是上一轮的。只在主线程上用。
final class UpdateGate {
  enum Purpose {
    case update(version: String)
    case staleServer(from: String)
  }

  enum Choice { case wait, now, cancel, recover }

  struct Prompt {
    let title: String
    let detail: String
    /// 第一个是默认（回车）。顺序与 `choices` 一一对应。
    let buttons: [String]
    let choices: [Choice]
    var affectedTasks: [String] = []
  }

  enum Phase { case idle, checking, waiting, blocked, preparing, prepared }

  static let shared = UpdateGate()

  /// 怎么问用户。缺省弹 NSAlert；回归测试换成照脚本作答。
  var ask: (Prompt) -> Choice = UpdateGate.runAlert
  /// 出错时怎么告诉用户（退出那一档另有按钮，见 `fail`）。
  var report: (String) -> Void = { _ = UpdateGate.runAlert(Prompt(title: "更新没装上", detail: $0, buttons: ["好"], choices: [.cancel])) }
  /// 闸关上（非 nil：正在换代码，窗口盖上这句话）/ 打开（nil：窗口重新连，需要时起服务）。
  var onHoldChanged: ((String?) -> Void)?
  /// 阶段变了（菜单里「安装更新」那一项跟着变）。
  var onPhaseChanged: (() -> Void)?
  var pollInterval: TimeInterval = 5
  var shutdownTimeout: TimeInterval = 20
  /// 另一处正在起服务时，等它起完再停的时限（比 ServerLauncher 的 45 秒略长）。
  var lockTimeout: TimeInterval = 50

  private(set) var phase: Phase = .idle { didSet { onPhaseChanged?() } }
  private var purpose: Purpose?
  private var proceeds: [() -> Void] = []
  private var quitReplies: [(Bool) -> Void] = []
  /// 退出那一档选了「等」：等完调它（没有别的安装回调排着时）。
  private var whenDrained: (() -> Void)?
  /// 退出那一档点「取消」时回到等待（取消前本来就在等）。
  private var resumeWaitingOnCancel = false
  private var pollTimer: Timer?
  private var polling = false
  private var epoch = 0
  private var maintenance: Maintenance?
  private var holding = false
  private var replacementLock: Int32?

  /// 这道闸正盖着窗口（本进程在停服务 / 备份 / 等 Sparkle 换 app）。
  var isHolding: Bool { holding }

  /// 有一次换代码在排着（在等任务跑完，或者上一次没装成、等用户再点）。
  var hasPending: Bool { !proceeds.isEmpty && phase != .preparing && phase != .prepared }

  var pendingMenuTitle: String {
    if phase == .blocked { return "重试切换新版服务…" }
    if case .staleServer = purpose { return "切换新版服务…" }
    return phase == .waiting ? "等任务跑完后安装更新…" : "安装更新…"
  }

  /// 「可以换代码了吗」。放行后（服务已停、库已备份）调 proceed。已经放行过就直接调。
  func request(_ purpose: Purpose, proceed: @escaping () -> Void) {
    if phase == .prepared { proceed(); return }
    if case .update = purpose, phase == .preparing {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.request(purpose, proceed: proceed) }
      return
    }
    if case .update = purpose { self.purpose = purpose } else if self.purpose == nil { self.purpose = purpose }
    proceeds.append(proceed)
    if case .update = purpose, RuntimeStore.destination != nil {
      stopPolling()
      evaluate()
      return
    }
    if phase == .idle || phase == .blocked { evaluate() }
  }

  /// 菜单里那一项：在等的时候重新问一遍（「现在装」的入口），没装成的时候再试一次。
  func reconsider() {
    guard hasPending, phase == .waiting || phase == .idle || phase == .blocked else { return }
    stopPolling()
    evaluate()
  }

  /// 用户要退出，而退出时 Sparkle 会把下好的更新装上：同一道闸，多一个「取消」。
  /// reply(true) = 可以退了；reply(false) = 这次别退。选了「等它们跑完」时，等完调 whenDrained。
  func requestForQuit(version: String, whenDrained: @escaping () -> Void, reply: @escaping (Bool) -> Void) {
    if case .staleServer = purpose, phase == .preparing {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
        self.requestForQuit(version: version, whenDrained: whenDrained, reply: reply)
      }
      return
    }
    switch phase {
    case .prepared: reply(true); return
    case .preparing: quitReplies.append(reply); return
    default: break
    }
    if purpose == nil || RuntimeStore.destination != nil { purpose = .update(version: version) }
    quitReplies.append(reply)
    self.whenDrained = whenDrained
    resumeWaitingOnCancel = phase == .waiting
    stopPolling()
    evaluate()
  }

  /// Sparkle 放弃了这次更新（安装出错、用户取消……）：作废排着的一切，放开闸让服务照常起。
  /// 正在停服务 / 备份的那一步回来时认得出自己已经作废（见 `settle`），由它收尾。
  func abandon(_ reason: String) {
    guard case .update = purpose else { return }
    log("Sparkle 放弃了这次更新（\(reason)）：作废排着的安装")
    epoch += 1
    stopPolling()
    proceeds = []
    whenDrained = nil
    purpose = nil
    let replies = quitReplies
    quitReplies = []
    let preparing = phase == .preparing
    phase = .idle
    if !preparing { releaseHold() }
    replies.forEach { $0(false) }
  }

  // MARK: 内部

  private func evaluate() {
    phase = .checking
    epoch += 1
    let mine = epoch
    if case .update = purpose, RuntimeStore.destination != nil {
      DispatchQueue.global(qos: .userInitiated).async { [self] in
        let result: Result<Int32, Error> = Result {
          try RuntimeStore.prepare()
          return try RuntimeStore.lockForReplacement()
        }
        DispatchQueue.main.async {
          guard mine == self.epoch else {
            if case .success(let descriptor) = result { close(descriptor) }
            return
          }
          switch result {
          case .success(let descriptor): self.replacementLock = descriptor; self.finish(stale: false)
          case .failure(let error): self.fail(error.localizedDescription)
          }
        }
      }
      return
    }
    let quitting = !quitReplies.isEmpty
    assess { [self] assessed in
      guard mine == epoch else { return }
      let verdict: ImpactVerdict
      if !assessed.needsConsent, preservingRuntime, let handoverBlock, let target = assessed.target {
        verdict = .disrupts(target, [(title: "旧服务", why: handoverBlock)])
      } else { verdict = assessed }
      guard verdict.needsConsent else { prepare(verdict.target); return }
      let choice = ask(prompt(for: verdict, quitting: quitting))
      // 弹窗开着的时候 Sparkle 可能已经放弃了这次更新。
      guard mine == epoch else { return }
      switch choice {
      case .now:
        prepare(verdict.target)
      case .recover:
        confirmRecovery(epoch: mine)
      case .wait:
        answerQuit(false)
        if quitting, proceeds.isEmpty, let whenDrained { proceeds.append(whenDrained) }
        startWaiting()
      case .cancel:
        answerQuit(false)
        if !quitting || resumeWaitingOnCancel { startWaiting() } else { phase = .idle }
      }
    }
  }

  private func confirmRecovery(epoch mine: Int) {
    guard case .staleServer = purpose, quitReplies.isEmpty, preservingRuntime else { return }
    DispatchQueue.global(qos: .userInitiated).async { [self] in
      let result = Result { try RestartImpactProbe.assessRecoverySync() }
      DispatchQueue.main.async {
        guard mine == self.epoch, case .staleServer = self.purpose, self.quitReplies.isEmpty else { return }
        switch result {
        case .failure(let error): self.fail(error.localizedDescription)
        case .success(let assessment):
          var detail = "将停止已确认的本机旧服务。任务、模型请求和 MCP 交卷可能中断；强制切换不保证无损接管。"
          var affected: [String] = []
          switch assessment.verdict {
          case .disrupts(_, let items): affected = items.map { "· \($0.title) —— \($0.why)" }
          case .unknown(let why): detail += "\n无法获取完整影响清单（\(why)），可能打断所有任务。"
          case .clear: detail += "\n当前没有已登记的任务；仍可能中断尚未登记的请求。"
          }
          detail += "\n停服务前会再次核对身份并保留迁移前恢复点；新版启动失败且未开始接管时自动恢复旧服务。"
          let choice = self.ask(Prompt(title: "打断任务并切换服务？", detail: detail,
            buttons: ["取消", "打断任务并切换"], choices: [.cancel, .recover], affectedTasks: affected))
          guard mine == self.epoch, case .staleServer = self.purpose, self.quitReplies.isEmpty else { return }
          if choice == .recover {
            self.prepare(.ours(pid: assessment.identity.pid), recovery: assessment.identity)
          } else { self.startWaiting() }
        }
      }
    }
  }

  private func assess(_ completion: @escaping (ImpactVerdict) -> Void) {
    let canPreserve: Bool = { if case .staleServer = purpose { return RuntimeStore.destination != nil }; return false }()
    DispatchQueue.global(qos: .userInitiated).async { [self] in
      let preservingRuntime: Bool = {
        guard canPreserve, case .navi(let instance) = NaviHealth.probeSync(), instance.isOurs,
              let codeDir = instance.codeDir else { return false }
        return RuntimeStore.contains(codeDir)
      }()
      let verdict = RestartImpactProbe.assessSync(preservingRuntime: preservingRuntime)
      DispatchQueue.main.async { self.preservingRuntime = preservingRuntime; completion(verdict) }
    }
  }

  private func answerQuit(_ allowed: Bool) {
    let replies = quitReplies
    quitReplies = []
    replies.forEach { $0(allowed) }
  }

  /// 只有**确认**没人会被打断才自己放行；确认不了（服务一时没答复、答的不像 navi……）就接着等。
  private func startWaiting() {
    phase = .waiting
    log("等会被打断的任务跑完，每 \(Int(pollInterval)) 秒再问一次")
    stopPolling()
    let mine = epoch
    pollTimer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
      guard let self, !self.polling, self.phase == .waiting, mine == self.epoch else { return }
      self.polling = true
      self.assess { verdict in
        guard mine == self.epoch else { return }
        self.polling = false
        if self.phase == .waiting && !verdict.needsConsent { self.prepare(verdict.target) }
      }
    }
  }

  private func stopPolling() {
    pollTimer?.invalidate()
    pollTimer = nil
    polling = false
  }

  private enum Step {
    case done(Maintenance)
    case changed(String)
    case failed(String)
  }

  private var preservingRuntime = false
  private var handoverBlock: String?

  /// 放行。`target` 是评估时端口上那一份；nil = 用户在确认不了时点了「现在」。
  private func prepare(_ target: ServiceTarget?, recovery: ServiceRecoveryIdentity? = nil) {
    guard phase != .preparing && phase != .prepared else { return }
    stopPolling()
    phase = .preparing
    let mine = epoch
    let stale: String? = { if case .staleServer(let from) = purpose { return from } else { return nil } }()
    let note = stale == nil ? "正在安装更新…" : "正在换成新版的 Navi 服务…"
    holding = true
    onHoldChanged?(note)
    log("放行：停服务、备份库")
    let (shutdownTimeout, lockTimeout) = (shutdownTimeout, lockTimeout)
    let preservingRuntime = self.preservingRuntime
    DispatchQueue.global(qos: .userInitiated).async { [self] in
      let step = Self.stopAndBackUp(target, note: note, fromVersion: stale ?? NaviConfig.bundleVersion,
                                    shutdownTimeout: shutdownTimeout, lockTimeout: lockTimeout,
                                    preservingRuntime: preservingRuntime, recovery: recovery)
      DispatchQueue.main.async {
        if recovery != nil, case .changed(let why) = step { self.fail(why); return }
        self.settle(step, epoch: mine, stale: stale != nil)
      }
    }
  }

  private static func stopAndBackUp(_ target: ServiceTarget?, note: String, fromVersion: String,
                                    shutdownTimeout: TimeInterval, lockTimeout: TimeInterval, preservingRuntime: Bool,
                                    recovery: ServiceRecoveryIdentity?) -> Step {
    let maintenance: Maintenance
    do {
      maintenance = try Maintenance.begin(note: note, timeout: lockTimeout)
    } catch {
      return .failed("\(error.localizedDescription)：先没停服务，更新没装。")
    }
    if let recovery {
      do {
        try RuntimeStore.prepare()
        guard let next = RuntimeStore.destination, RuntimeStore.contains(next.path) else {
          throw SQLiteFile.Failure("新版运行时未完整准备，未停止旧服务")
        }
        try recovery.verify()
      }
      catch { maintenance.end(); return .changed(error.localizedDescription) }
    }
    var lease: String?
    if recovery == nil, preservingRuntime, case .ours = target {
      lease = RuntimeHandover.acquire(target: target)
      guard lease != nil else {
        maintenance.end()
        return .changed("旧服务暂不能安全接管，继续使用旧服务")
      }
    }
    defer { if let lease { RuntimeHandover.release(lease) } }
    var previous: String?
    if preservingRuntime {
      do {
        guard case .navi(let instance) = NaviHealth.probeSync(), instance.isOurs, let code = instance.codeDir else {
          throw SQLiteFile.Failure("旧服务身份已改变")
        }
        if let recovery, !recovery.matches(instance) { throw SQLiteFile.Failure("服务身份已变化，本次强制切换已取消") }
        previous = code
        let backup = try DatabaseBackup.beforeUpdate(fromVersion: fromVersion)
        try RuntimeRecovery.record(previous: code, backup: backup, next: recovery == nil ? nil : RuntimeStore.destination)
      }
      catch {
        maintenance.end()
        return .failed("迁移前备份失败，旧服务未停止：\(error.localizedDescription)")
      }
      if let lease, !RuntimeHandover.isValid(lease) {
        maintenance.end()
        return .changed("接管许可已失效，旧服务未停止")
      }
    }
    switch ServerShutdown.stop(expecting: target, timeout: shutdownTimeout, identity: recovery) {
    case .changed(let why):
      maintenance.end()
      return .changed(why)
    case .failed(let reason):
      maintenance.end()
      return .failed(reason)
    case .stopped(let pid):
      if preservingRuntime {
        do {
          let backup = try DatabaseBackup.beforeUpdate(fromVersion: fromVersion)
          if let previous {
            try RuntimeRecovery.record(previous: previous, backup: backup, finalized: true,
                                       next: recovery == nil ? nil : RuntimeStore.destination)
          }
          if recovery != nil, let next = RuntimeStore.destination { try RuntimeStore.activate(next) }
          return .done(maintenance)
        } catch {
          maintenance.end()
          return .failed("服务已停止，但迁移前最终快照失败，未启动新版：\(error.localizedDescription)")
        }
      }
      logger.notice("服务已下线（进程 \(pid.map(String.init) ?? "本来就不在", privacy: .public)）")
      do {
        let backup = try DatabaseBackup.beforeUpdate(fromVersion: fromVersion)
        logger.notice("库已备份：\(backup?.path ?? "数据根里还没有库，不用备份", privacy: .public)")
        return .done(maintenance)
      } catch {
        maintenance.end()
        return .failed("更新前备份库没成功（\(error.localizedDescription)），更新没装。")
      }
    }
  }

  private func settle(_ step: Step, epoch mine: Int, stale: Bool) {
    guard mine == epoch else {
      // 停服务、备份的时候这一轮被作废了（Sparkle 放弃了）：收回维护，窗口重连、服务照常起。
      // 这期间已经开了新的一轮、也走到了停服务那一步的话，闸归它管。
      if case .done(let maintenance) = step { maintenance.end() }
      if phase != .preparing && phase != .prepared { releaseHold() }
      return
    }
    switch step {
    case .done(let maintenance):
      self.maintenance = maintenance
      finish(stale: stale)
    case .changed(let why):
      log("没停服务：\(why)。重新评估")
      if preservingRuntime {
        handoverBlock = why
        stopPolling()
        phase = .blocked
        releaseHold()
        answerQuit(false)
        report("\(why)。旧服务继续运行，自动切换已暂停；请从菜单重试切换新版服务。")
      } else { releaseHold(); evaluate() }
    case .failed(let reason):
      fail(reason)
    }
  }

  private func finish(stale: Bool) {
    let run = proceeds
    let replies = quitReplies
    proceeds = []
    quitReplies = []
    whenDrained = nil
    if stale {
      // 服务换代码这件事到这儿就完了：放开闸，窗口重连时用新版起服务。
      purpose = nil
      handoverBlock = nil
      phase = .idle
      releaseHold()
    } else {
      // 停在这里，直到 Sparkle 换完 app、把这个进程退掉（不放开闸：放开就会拿旧代码再起一份）。
      phase = .prepared
    }
    run.forEach { $0() }
    replies.forEach { $0(true) }
  }

  /// 停不下来 / 备份不成：不放行。安装回调留着（菜单里「安装更新…」可以再试）。
  private func fail(_ reason: String) {
    log("没装成：\(reason)")
    phase = .idle
    releaseHold()
    let replies = quitReplies
    quitReplies = []
    if replies.isEmpty {
      report(reason)
      return
    }
    // 要退出的那一档不能把人困住（盘满了备份一直不成功时总得退得掉）。可 Sparkle 没有「撤销
    // 退出时安装」的接口，退出就会换上新版 —— 所以兜底在新版那头：起服务前先备份，备份不成就
    // 不起、不碰库（ServerLauncher.backUpBeforeMigration）；旧服务没停下的，新版认得出、再过一次闸。
    let choice = ask(Prompt(title: "更新没装上", detail: "\(reason)\n\n仍然退出的话，Sparkle 会在退出时换上新版 app。"
                              + "新版起服务之前会先备份库，备份不成就不起服务、不碰库；旧服务要是还在跑，新版打开后会认出它、再问一次。",
                            buttons: ["不退出", "仍然退出"], choices: [.cancel, .now]))
    replies.forEach { $0(choice == .now) }
  }

  private func releaseHold() {
    if let replacementLock { close(replacementLock); self.replacementLock = nil }
    maintenance?.end()
    maintenance = nil
    guard holding else { return }
    holding = false
    onHoldChanged?(nil)
  }

  private func prompt(for verdict: ImpactVerdict, quitting: Bool) -> Prompt {
    let title: String
    var lines: [String] = []
    let (waitTitle, nowTitle): (String, String)
    switch purpose {
    case .staleServer(let from):
      title = "Navi 服务还在跑旧版（\(from)）"
      lines.append("app 已经是新版，换上新版的服务要重启它。")
      (waitTitle, nowTitle) = ("等它们跑完再重启", "现在重启")
    case .update(let version):
      title = "装新版 \(version) 要重启 Navi 服务"
      (waitTitle, nowTitle) = ("等它们跑完再装", "现在装")
    case nil:
      title = "装新版要重启 Navi 服务"
      (waitTitle, nowTitle) = ("等它们跑完再装", "现在装")
    }
    if quitting { lines.append("退出 Navi 时 Sparkle 会把下好的新版装上。") }
    switch verdict {
    case .disrupts(_, let items):
      lines.append("会打断 \(items.count) 个任务：")
      lines += items.prefix(8).map { "· \($0.title) —— \($0.why)" }
      if items.count > 8 { lines.append("……还有 \(items.count - 8) 个") }
    case .unknown(let why):
      lines.append("确认不了重启会不会打断任务（\(why)）。确认不了不等于没有。")
    case .clear:
      break
    }
    log("问用户：\(title)；\(lines.joined(separator: " "))")
    var buttons = [waitTitle, nowTitle]
    var choices: [Choice] = [.wait, .now]
    if case .staleServer = purpose, RuntimeStore.destination != nil {
      buttons = [waitTitle]
      choices = [.wait]
      if preservingRuntime && !quitting {
        buttons.append("强制切换服务…")
        choices.append(.recover)
      }
      if !quitting { buttons.append("稍后"); choices.append(.cancel) }
    }
    if quitting {
      buttons.append("取消")
      choices.append(.cancel)
    }
    return Prompt(title: title, detail: lines.joined(separator: "\n"), buttons: buttons, choices: choices)
  }

  static func runAlert(_ prompt: Prompt) -> Choice {
    let alert = NSAlert()
    alert.messageText = prompt.title
    alert.informativeText = prompt.detail
    if prompt.choices == [.cancel, .recover] { alert.alertStyle = .critical }
    if !prompt.affectedTasks.isEmpty {
      let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 440, height: 180))
      let text = NSTextView(frame: scroll.bounds)
      text.isEditable = false
      text.isVerticallyResizable = true
      text.autoresizingMask = [.width]
      text.drawsBackground = false
      text.font = .systemFont(ofSize: 13)
      text.string = prompt.affectedTasks.joined(separator: "\n\n")
      text.textContainer?.widthTracksTextView = true
      text.textContainer?.containerSize = NSSize(width: 440, height: CGFloat.greatestFiniteMagnitude)
      text.layoutManager?.ensureLayout(for: text.textContainer!)
      let height = text.layoutManager?.usedRect(for: text.textContainer!).height ?? 180
      text.setFrameSize(NSSize(width: 440, height: max(180, height + 16)))
      scroll.hasVerticalScroller = true
      scroll.documentView = text
      alert.accessoryView = scroll
    }
    for title in prompt.buttons { alert.addButton(withTitle: title) }
    alert.buttons.first?.keyEquivalent = "\r"
    if let cancel = prompt.choices.firstIndex(of: .cancel) { alert.buttons[cancel].keyEquivalent = "\u{1b}" }
    alert.window.defaultButtonCell = alert.buttons.first?.cell as? NSButtonCell
    let cancelMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
      guard event.keyCode == 53, event.window === alert.window,
            let cancel = prompt.choices.firstIndex(of: .cancel) else { return event }
      alert.buttons[cancel].performClick(nil)
      return nil
    }
    defer { if let cancelMonitor { NSEvent.removeMonitor(cancelMonitor) } }
    NSApp.activate(ignoringOtherApps: true)
    let index = alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
    return prompt.choices.indices.contains(index) ? prompt.choices[index] : .cancel
  }

  /// 记进系统日志（Console.app 里按子系统 = bundle id、类别 update 过滤）：事后查「为什么没装 / 为什么问了」。
  static let logger = Logger(subsystem: NaviConfig.bundleID, category: "update")

  private func log(_ message: String) {
    Self.logger.notice("\(message, privacy: .public)")
  }
}
