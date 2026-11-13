import AppKit

/// 窗口「回到 ash」的那条路：认清端口上是谁 → 不在就起 → 首启先问数据从哪来 → 都对了才载页面。
extension BrowserWindowController {
  /// 本机地址先认清端口上是不是自己那份（不在就起，被别人占着就说明），确认了才载页面；
  /// 连别处的 ash 时直接载。
  func loadHome() {
    stopHealthPolling()
    stopInstanceGuard()
    guard AshConfig.isLocal else { loadPage(); return }
    connect()
  }

  /// 页面载不进来（导航失败）。本机地址重走一遍 connect —— 服务可能挂了，也可能端口换了人。
  func showOffline(_ error: Error) {
    stopInstanceGuard()
    if AshConfig.isLocal { connect(); return }
    offlineView.show(title: "连不上 \(AshConfig.baseURL.absoluteString)",
                     detail: "\(error.localizedDescription)\n服务起来后会自动载入。",
                     actions: [OfflineView.Action(title: "重试") { [weak self] in self?.loadHome() }])
    startHealthPolling()
  }

  private func connect() {
    pendingStartingScreen?.cancel()
    let starting = DispatchWorkItem { [weak self] in
      self?.offlineView.show(title: "正在启动 ash 服务…", detail: AshConfig.baseURL.absoluteString, busy: true)
    }
    pendingStartingScreen = starting
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: starting)
    ServerLauncher.shared.ensureRunning { [weak self] outcome in
      starting.cancel()
      self?.present(outcome)
    }
  }

  private func present(_ outcome: ServerLauncher.Outcome) {
    let retry = OfflineView.Action(title: "重试") { [weak self] in self?.loadHome() }
    switch outcome {
    case .ready:
      loadPage()
      HostMcpSetup.runOnceIfNeeded(window: window)
    case .needsSetup:
      showFirstRun()
    case .occupied(let explanation):
      offlineView.show(title: "\(AshConfig.port) 端口被占着", detail: explanation, actions: [retry])
      startHealthPolling(takeOverWhenFree: true)
    case .failed(let reason):
      let log = ServerLauncher.shared.logURL
      var actions = [retry]
      if FileManager.default.fileExists(atPath: log.path) {
        actions.insert(OfflineView.Action(title: "日志") { NSWorkspace.shared.open(log) }, at: 0)
      }
      offlineView.show(title: "ash 服务没起来", detail: reason, actions: actions)
      startHealthPolling()
    }
  }

  // MARK: 首启：全新开始 / 导入已有数据

  private func showFirstRun(note: String? = nil) {
    var detail = "数据放在 \(AshConfig.dataURL.path)。\n已经在用 ash 的话，可以把那份数据导进来（只复制，原来那份不动）。"
    if let note { detail = "\(note)\n\n\(detail)" }
    offlineView.show(title: "第一次打开 ash", detail: detail, actions: [
      OfflineView.Action(title: "导入已有数据…") { [weak self] in self?.chooseImport() },
      OfflineView.Action(title: "全新开始") { [weak self] in
        ServerLauncher.shared.freshStartApproved = true
        self?.loadHome()
      },
    ])
  }

  private func chooseImport() {
    guard let window else { return }
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.message = "选一份 ash 的数据目录（里面有 ash.db，比如仓库里的 data/）"
    panel.prompt = "导入"
    panel.beginSheetModal(for: window) { [weak self] response in
      guard response == .OK, let url = panel.url else { return }
      self?.importData(from: url)
    }
  }

  private func importData(from url: URL) {
    guard let window else { return }
    let source: DataImport.Source
    do {
      source = try DataImport.inspect(url)
    } catch {
      showFirstRun(note: error.localizedDescription)
      return
    }
    guard let pid = source.livePID else { runImport(source); return }
    let alert = NSAlert()
    alert.messageText = "这份数据正被另一份 ash 用着（进程 \(pid)）"
    alert.informativeText = "导入的是它此刻的快照，之后它那边的变化不会过来。它手上在跑的任务仍归它管，"
      + "导进来的那一份只记作暂停，不会去接管。打算从此改用 app 的话，先停掉它（kill \(pid)）再导入更干净。"
    alert.addButton(withTitle: "仍然导入")
    alert.addButton(withTitle: "取消")
    alert.beginSheetModal(for: window) { [weak self] response in
      if response == .alertFirstButtonReturn { self?.runImport(source) }
    }
  }

  private func runImport(_ source: DataImport.Source) {
    offlineView.show(title: "正在导入…", detail: source.url.path, busy: true)
    DispatchQueue.global(qos: .userInitiated).async {
      let outcome = Result { try DataImport.run(source, into: AshConfig.dataURL) }
      DispatchQueue.main.async { [weak self] in
        switch outcome {
        case .failure(let error): self?.showFirstRun(note: "导入没成功：\(error.localizedDescription)")
        case .success(let report):
          self?.loadHome()
          self?.tellHeld(report)
        }
      }
    }
  }

  /// 导入时停下来的东西说一声：它们在源实例上可能还在跑，副本里只是记作暂停/停用，要接着做得自己点。
  private func tellHeld(_ report: DataImport.Report) {
    let labels: [(String, String)] = [
      ("tasks", "个在跑或排队的任务，已暂停"),
      ("monitors", "个在盯的哨兵，已结束"),
      ("gates", "次在跑的验收前置命令，记为被打断"),
      ("reviews", "个进行中的审查或辩论，已中止"),
      ("schedules", "个定时任务，已停用"),
      ("messages", "条还没发出的消息，已取消"),
    ]
    let lines = labels.compactMap { key, label in report.held[key].map { "· \($0) \(label)" } }
    guard !lines.isEmpty, let window else { return }
    let alert = NSAlert()
    alert.messageText = "导入好了，有些事没有接着做"
    alert.informativeText = "导入不是接管：原来那份 ash 手上的活仍归它，这里不会替它续跑。\n\n"
      + lines.joined(separator: "\n") + "\n\n要在这里接着做，到对应的任务里继续或重新打开。"
    alert.beginSheetModal(for: window)
  }
}
