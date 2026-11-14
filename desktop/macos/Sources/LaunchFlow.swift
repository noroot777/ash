import AppKit

/// 窗口「回到 ash」的那条路：认清端口上是谁 → 不在就起 → 首启先问数据从哪来 → 都对了才载页面。
extension BrowserWindowController {
  /// 本机地址先认清端口上是不是自己那份（不在就起，被别人占着就说明），确认了才载页面；
  /// 连别处的 ash 时直接载。
  func loadHome() {
    stopHealthPolling()
    guard AshConfig.isLocal else { loadPage(); return }
    connect()
  }

  /// 页面载不进来（导航失败）。本机地址重走一遍 connect —— 服务可能挂了，也可能端口换了人。
  func showOffline(_ error: Error) {
    if AshConfig.isLocal { connect(); return }
    offlineView.show(title: "连不上 \(AshConfig.baseURL.absoluteString)",
                     detail: "\(error.localizedDescription)\n服务起来后会自动载入。",
                     actions: [OfflineView.Action(title: "重试") { [weak self] in self?.loadHome() }])
    startHealthPolling()
  }

  private func connect() {
    if let note = ServerLauncher.shared.hold {
      showInstalling(note)
      // 维护在别的进程里（另开的一份 app 在装更新）：它完了不会通知这里，过一会儿再看一次。
      if !UpdateGate.shared.isHolding {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.loadHome() }
      }
      return
    }
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
      checkStaleServer()
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
      // 刚装完新版就起不来，多半是新版的迁移出了问题：指一下更新前的库备份在哪（怎么回到旧版见 README）。
      var detail = reason
      if let backup = DatabaseBackup.existing().first {
        detail += "\n\n刚更新过的话：更新前的库备份在 \(backup.path)，配上那一版 app 能回到旧版。"
        actions.insert(OfflineView.Action(title: "更新前的备份") {
          NSWorkspace.shared.activateFileViewerSelecting([backup])
        }, at: 0)
      }
      offlineView.show(title: "ash 服务没起来", detail: detail, actions: actions)
      startHealthPolling()
    }
  }

  /// 端口上那份是旧版 app 起的（见 ServerRecord）：过 UpdateGate 换成新版。
  private func checkStaleServer() {
    guard UpdateGate.shared.phase == .idle else { return }
    DispatchQueue.global(qos: .utility).async {
      guard case .ash(let instance) = AshHealth.probeSync(), instance.isOurs,
            let from = ServerRecord.staleVersion(servingPID: instance.pid) else { return }
      DispatchQueue.main.async {
        guard UpdateGate.shared.phase == .idle else { return }
        UpdateGate.shared.request(.staleServer(from: from)) {}
      }
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
    alert.informativeText = "导入的是它此刻的快照，之后它那边的变化不会过来；它手上在跑的任务也会在两边各记一份。"
      + "稳妥的做法是先停掉它（kill \(pid)）再导入。"
    alert.addButton(withTitle: "仍然导入")
    alert.addButton(withTitle: "取消")
    alert.beginSheetModal(for: window) { [weak self] response in
      if response == .alertFirstButtonReturn { self?.runImport(source) }
    }
  }

  private func runImport(_ source: DataImport.Source) {
    offlineView.show(title: "正在导入…", detail: source.url.path, busy: true)
    DispatchQueue.global(qos: .userInitiated).async {
      let failure: String?
      do {
        try DataImport.run(source, into: AshConfig.dataURL)
        failure = nil
      } catch {
        failure = "导入没成功：\(error.localizedDescription)"
      }
      DispatchQueue.main.async { [weak self] in
        if let failure { self?.showFirstRun(note: failure) } else { self?.loadHome() }
      }
    }
  }
}
