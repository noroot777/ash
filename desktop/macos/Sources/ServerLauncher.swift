import Foundation

/// 把自带的那份 navi 服务起起来：用 bundle 里的 node 跑 bundle 里的 server，数据根交给
/// `NAVI_DATA_DIR`，带 `NAVI_DESKTOP_APP=1`（app 起的那一份：固定自用、听窗口专用端口），没打开
/// 「允许其他设备访问」时再带 `NAVI_LOCAL_ONLY=1`（只听 127.0.0.1、没有远程配对）。
///
/// server 由 `scripts/start-detached.mjs` 放进自己的会话、脱离本进程 —— 关窗、退出 app 都不会
/// 带走服务，更不会带走它名下在跑的 agent。这里**只负责起**：不杀旧进程、不守护。
///
/// 环境走用户的交互式登录 shell（`zsh -ilc`）：从访达 / Dock 打开的 app 只有 `/usr/bin:/bin`
/// 这类最小 PATH，而 server 要拉起的 claude、codex、kimi 装在 Homebrew 与 ~/.xxx/bin 里，PATH 在
/// .zprofile / .zshrc 里拼出来。node 不从这份 PATH 里找 —— 用的一律是 bundle 里那一个。
final class ServerLauncher {
  enum Outcome {
    case ready
    /// 数据根还是空的：等用户在首启那一屏选「全新开始」或「导入已有数据」。
    case needsSetup
    /// 端口被别的 navi / 别的程序占着。带着说给用户听的那段话：是谁、怎么办。
    case occupied(String)
    case failed(String)
  }

  static let shared = ServerLauncher()

  /// 用户在首启那一屏点了「全新开始」：空数据根也可以起（会建一份新库）。无窗口的
  /// `--start-server` 永远不替用户做这个决定 —— 否则登录项抢先建出空库，导入的入口就没了。
  var freshStartApproved = false

  /// 正在换代码（UpdateGate 停了服务、在备份库、等 Sparkle 换 app）：这期间谁来要服务都不起，
  /// 否则窗口的探活一发现服务不在，就会拿**旧版**代码再起一份，迁移前的备份和新版都白做。
  /// 记在数据根里（见 Maintenance），别的进程里的维护也算。值是说给用户听的那句话。
  var hold: String? { Maintenance.activeNote() }

  var logURL: URL { NaviConfig.serverLogURL }

  private let queue = DispatchQueue(label: "dev.navi.server-launcher")
  private let requests = NSLock()
  private var completions: [(Outcome) -> Void] = []

  /// 确保服务在跑：自己那份通着就直接 ready；没通就起一个并等它应答。同时来的请求合成一次。
  func ensureRunning(timeout: TimeInterval = 45, completion: @escaping (Outcome) -> Void) {
    requests.lock()
    completions.append(completion)
    let shouldStart = completions.count == 1
    requests.unlock()
    guard shouldStart else { return }
    queue.async {
      let outcome = self.ensureRunningSync(timeout: timeout)
      self.requests.lock()
      let callbacks = self.completions
      self.completions.removeAll()
      self.requests.unlock()
      DispatchQueue.main.async { callbacks.forEach { $0(outcome) } }
    }
  }

  func ensureRunningSync(timeout: TimeInterval) -> Outcome {
    if case .failure(let error) = RuntimeStore.selected { return .failed("运行时准备失败：\(error.localizedDescription)") }
    if let settled = Self.settle(NaviHealth.probeSync()) { return settled }
    if let hold { return .failed(hold) }
    guard NaviConfig.isLocal else {
      return .failed("连不上 \(NaviConfig.baseURL.absoluteString)。它不是本机地址，app 不会替它启动服务。")
    }
    guard NaviConfig.isDataInitialized || freshStartApproved else { return .needsSetup }
    let lock: ServerStartLock
    do {
      lock = try ServerStartLock(dataDir: NaviConfig.dataURL)
      let deadline = Date().addingTimeInterval(timeout)
      while try !lock.tryAcquire() {
        if let settled = Self.settle(NaviHealth.probeSync()) { return settled }
        if let hold { return .failed(hold) }
        guard Date() < deadline else { return .failed("等另一处启动 Navi 服务超时。可以重试；服务起来后也会自动载入。") }
        Thread.sleep(forTimeInterval: 0.2)
      }
    } catch {
      return .failed("无法取得服务启动锁：\(error.localizedDescription)")
    }
    defer { withExtendedLifetime(lock) {} }
    if let settled = Self.settle(NaviHealth.probeSync()) { return settled }
    if let hold { return .failed(hold) }
    if let failure = Self.backUpBeforeMigration() { return .failed(failure) }
    let parts = [NaviConfig.nodeURL, NaviConfig.serverEntryURL, NaviConfig.detachScriptURL]
    if let missing = parts.first(where: { !FileManager.default.fileExists(atPath: $0.path) }) {
      return .failed("app 里自带的 Navi 不完整（缺 \(missing.path)）。重新装一次 Navi.app。")
    }
    do {
      try FileManager.default.createDirectory(at: NaviConfig.logURL, withIntermediateDirectories: true)
    } catch {
      return .failed("建不了日志目录 \(NaviConfig.logURL.path)：\(error.localizedDescription)")
    }
    switch spawnDetached() {
    case .failure(let reason): return .failed(reason)
    case .success(let pid):
      // 进程一起来就记下 pid：这个启动器等不到它应答（被退掉、超时）也不要紧，之后谁看到它应答
      // 都能认出是它、替它确认（见 settle）。
      ServerRecord.write(pid: Int(pid))
      let outcome = waitReady(pid: pid, timeout: timeout)
      if case .ready = outcome { return outcome }
      guard kill(pid, 0) != 0 && errno == ESRCH else { return outcome }
      do {
        if let previous = try RuntimeRecovery.restoreBeforeAdoption() {
          switch spawnDetached(runtime: previous) {
          case .failure(let reason): return .failed("新版启动失败，库已恢复，但旧服务也未启动：\(reason)")
          case .success(let restoredPID):
            if case .ready = waitReady(pid: restoredPID, timeout: timeout) {
              if let record = ServerRecord.read() {
                let restored = ServerRecord(pid: Int(restoredPID), bundleVersion: record.bundleVersion, confirmedAt: Date())
                try JSONEncoder().encode(restored).write(to: ServerRecord.url, options: .atomic)
              }
              return .failed("新版迁移未完成，已恢复迁移前的库并启动旧运行时；任务继续运行。修复新版后点「重试」。")
            }
            return .failed("库已恢复，但旧服务未就绪；恢复点仍在 backups 目录。")
          }
        }
      } catch { return .failed("新版启动失败：\(error.localizedDescription)") }
      return outcome
    }
  }

  /// 起服务之前：这份库上一次交给别的构建号的 app 起（或者不知道是谁），这一版的 server 一起来就
  /// 可能迁移它，迁移不可逆，所以先留底。不用再留的两种：
  ///  · 上一次交给的就是这一版 —— 这一版已经在这份库上起过（成了就没有迁移要做，没成的话它起之前
  ///    已经留过底，这会儿的库可能已经被失败的迁移改过一半，再备就是拿半截库去挤原件）；
  ///  · 这一次已经备过（UpdateGate 装更新前留的、仍固定着的恢复点，见 DatabaseBackup.covers）。
  /// 其余的 —— 退出时没过闸就被 Sparkle 装上了、`build.sh --install`、手动换了 app、导入来的库 ——
  /// 在这里补一份。备份不成、或者记不下「这一版要起了」就不起：库原样留着，配上旧版 app 还能回去。
  /// 返回 nil = 可以起。
  private static func backUpBeforeMigration() -> String? {
    do {
      guard try DatabaseFile.existing(in: NaviConfig.dataURL) != nil else { return nil }
    } catch {
      return "数据根里的库认不准（\(error.localizedDescription)），没备份、也没起服务。照提示处理好再点「重试」（docs/rename-db.md）。"
    }
    let lastServedBy = ServerRecord.read()?.bundleVersion ?? "unknown"
    do {
      if lastServedBy != NaviConfig.bundleVersion && !DatabaseBackup.covers(lastServedBy: lastServedBy) {
        try DatabaseBackup.beforeUpdate(fromVersion: lastServedBy)
      }
    } catch {
      return "这一版要在库上做迁移，迁移前先备份库没成功（\(error.localizedDescription)），所以没起服务、库没动过。\n"
        + "腾出空间 / 修好权限后点「重试」；要回到旧版，把旧版 app 装回来就行（README「回到旧版」）。"
    }
    do {
      try ServerRecord.writeAttempt()
    } catch {
      return "记不下这一次要起的是哪一版（\(NaviConfig.dataURL.path)：\(error.localizedDescription)），所以没起服务、库没动过。修好权限 / 腾出空间后点「重试」。"
    }
    return nil
  }

  /// 探到的结果里哪些已经是结论：自己那份在 → ready；别人占着 → occupied；连不上 → nil（接着起）。
  static func settle(_ probe: NaviProbe) -> Outcome? {
    switch probe {
    case .down, .unreachable: return nil
    case .notNavi(let what): return .occupied(Occupant.notNavi(what))
    case .navi(let instance):
      guard NaviHealth.isServing(probe) else { return .occupied(Occupant.otherNavi(instance)) }
      // 不管服务是谁起的、谁先看到它起来，确认都在这一处（窗口、登录项、另一个窗口的重试都经过这里）。
      if NaviConfig.isLocal {
        ServerRecord.confirmServing(pid: instance.pid)
        RuntimeRecovery.confirmed(instance)
        ServedInstance.observe(instance)
        if instance.codeDir.map({ NaviHealth.samePath($0, NaviConfig.runtimeURL.path) }) == true {
          DispatchQueue.global(qos: .utility).async { RuntimeStore.reclaim() }
        }
      }
      return .ready
    }
  }

  private enum Spawned { case success(Int32), failure(String) }

  private func spawnDetached(runtime: URL = NaviConfig.runtimeURL) -> Spawned {
    let shell = Process()
    shell.executableURL = URL(fileURLWithPath: Self.loginShell())
    // 登录 shell 只负责拼出 PATH、LANG 这些。.zprofile / .zshrc 跑在这段命令**之前**，里面给开发实例
    // export 过的 NAVI_DATA_DIR、PORT、NAVI_LOCAL_ONLY 会盖掉事先放进环境的值 —— 所以 app 定下的这几样
    // 写成命令里的字面量，由 `env` 在 exec 的边界上落定（shell 带来的 PORT 先清掉）。server 读变量时
    // 新名优先、退到改名前的 ASH_ / HARNESS_（shared/src/env-names.ts），所以开关一律写新名、两个值都写明
    // （本机模式写 0 而不是不写，rc 里旧名的 1 就顶不上来）；数据根几代名字指向不同就拒绝起，旧名先清掉。
    // 这几个是给 server 的，它读完就从自己的环境里删掉（见 server/src/paths.ts、local-only.ts、
    // window-port.ts），agent 拿不到。`builtin cd`：rc 里常有 `alias cd=z`。
    let data = Self.quoted(NaviConfig.dataURL.path)
    let node = Self.quoted(runtime.appendingPathComponent("node/bin/node").path)
    // 默认端口不传 PORT：server 的环境会一路继承给 agent 与应用内终端，多一个 PORT 会让
    // 里面起的前端 dev server 去抢 navi 的端口。
    let port = NaviConfig.port == 4317 ? "" : " PORT=\(NaviConfig.port)"
    let localOnly = NaviConfig.allowsOtherDevices ? "0" : "1"
    let script = "builtin cd -- \(data) && exec /usr/bin/env -u PORT -u ASH_DATA_DIR -u HARNESS_DATA_DIR"
      + " NAVI_DATA_DIR=\(data) NAVI_DESKTOP_APP=1 NAVI_LOCAL_ONLY=\(localOnly)"
      + " NAVI_MAC_SOURCE_RUNTIME=\(Self.quoted(NaviConfig.bundledRuntimeURL.path))"
      + " NAVI_WINDOW_PORT=\(NaviConfig.windowPort)\(port) "
      + "\(node) \(Self.quoted(runtime.appendingPathComponent("scripts/start-detached.mjs").path)) \(Self.quoted(logURL.path)) \(node) \(Self.quoted(runtime.appendingPathComponent("server/dist/index.js").path))"
    shell.arguments = ["-ilc", script]
    shell.environment = Self.terminalLikeEnvironment()
    let launchLog = NaviConfig.logURL.appendingPathComponent("launch-\(UUID().uuidString).log")
    guard FileManager.default.createFile(atPath: launchLog.path, contents: nil),
          let output = try? FileHandle(forWritingTo: launchLog) else {
      return .failure("无法创建启动器日志。")
    }
    defer { try? output.close() }
    shell.standardOutput = output
    shell.standardError = output
    shell.standardInput = FileHandle.nullDevice
    do { try shell.run() } catch { return .failure("拉不起登录 shell：\(error.localizedDescription)") }

    // .zshrc 里万一有等输入的东西，别让启动器一起卡死。
    let deadline = Date().addingTimeInterval(20)
    while shell.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
    if shell.isRunning {
      shell.terminate()
      Thread.sleep(forTimeInterval: 0.2)
      if shell.isRunning { kill(shell.processIdentifier, SIGKILL) }
      shell.waitUntilExit()
      return .failure("登录 shell 20 秒没返回，可能是 .zshrc 在等输入。启动器日志：\(launchLog.path)")
    }
    let text = (try? String(contentsOf: launchLog, encoding: .utf8)) ?? ""
    let last = text.components(separatedBy: .whitespacesAndNewlines).last { !$0.isEmpty }
    guard shell.terminationStatus == 0, let last, let pid = Int32(last) else {
      return .failure("启动命令失败（退出码 \(shell.terminationStatus)）：\(text.suffix(1600))\n启动器日志：\(launchLog.path)")
    }
    try? FileManager.default.removeItem(at: launchLog)
    return .success(pid)
  }

  /// 等刚起的那个进程应答。它先退了、或者端口被别人抢先占上，都不必等满时限。
  private func waitReady(pid: Int32, timeout: TimeInterval) -> Outcome {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      let probe = NaviHealth.probeSync()
      if case .navi(let instance) = probe, instance.isOurs, instance.pid == Int(pid) {
        ServerRecord.confirmServing(pid: Int(pid))
        RuntimeRecovery.confirmed(instance)
        ServedInstance.observe(instance)
        return .ready
      }
      if case .navi(let instance) = probe, !instance.isOurs { return .occupied(Occupant.otherNavi(instance)) }
      if kill(pid, 0) != 0 && errno == ESRCH {
        return .failed("服务进程 \(pid) 起来就退出了：\n\(logTail())\n完整日志：\(logURL.path)")
      }
      Thread.sleep(forTimeInterval: 0.5)
    }
    return .failed("服务进程 \(pid) 起了，但 \(Int(timeout)) 秒内没应答 /api/health。看日志 \(logURL.path)。")
  }

  private func logTail() -> String {
    guard let text = try? String(contentsOf: logURL, encoding: .utf8) else { return "（没有日志）" }
    return String(text.suffix(1200)).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// 从一份「刚打开终端」的底子开始，剩下的交给登录 shell 自己拼。不直接继承 app 的环境：
  /// launchd 给 GUI app 的那份带着 XPC_SERVICE_NAME、__CFBundleIdentifier 这类只属于本 app
  /// 的东西，而且没有 LANG —— 少了它 agent 输出的中文会按 ASCII 处理。
  private static func terminalLikeEnvironment() -> [String: String] {
    let inherited = ProcessInfo.processInfo.environment
    var env: [String: String] = [
      "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
      "SHELL": loginShell(),
      "TERM": "xterm-256color",
      "LANG": inherited["LANG"] ?? "zh_CN.UTF-8",
    ]
    for key in ["HOME", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK"] {
      if let value = inherited[key] { env[key] = value }
    }
    return env
  }

  /// 单引号包起来：命令里只有这几段是外来的字符串，shell 不会再展开里面的任何东西。
  private static func quoted(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
  }

  private static func loginShell() -> String {
    if let pw = getpwuid(getuid()), let shell = pw.pointee.pw_shell { return String(cString: shell) }
    return "/bin/zsh"
  }
}

/// 「端口被占着」时说给用户听的那段话：是谁、怎么办。
enum Occupant {
  static func otherNavi(_ instance: NaviInstance) -> String {
    let port = NaviConfig.port
    let who = instance.pid.map { "进程 \($0)" } ?? "进程号不明"
    var lines = ["\(port) 端口上已经有一份 Navi 在跑（\(who)），但它不是这个 app 起的那份，所以没有连上去。\(instance.mismatch ?? "")"]
    if let codeDir = instance.codeDir, let dataDir = instance.dataDir {
      lines.append("代码：\(codeDir)\n数据：\(dataDir)")
      if FileManager.default.fileExists(atPath: URL(fileURLWithPath: codeDir).appendingPathComponent(".git").path) {
        lines.append("这是仓库里起的开发实例（npm run restart）。")
      }
    }
    let stop = instance.pid.map { "kill \($0)" } ?? "lsof -nP -iTCP:\(port) -sTCP:LISTEN 找到它再停"
    lines.append("要用 app：先停掉它（\(stop)），再点「重试」。开发实例以后换个端口起，例如 PORT=14317 npm run restart。")
    return lines.joined(separator: "\n\n")
  }

  static func notNavi(_ what: String) -> String {
    let port = NaviConfig.port
    return "\(port) 端口被别的程序占着（它应答了 \(what)，不是 Navi），Navi 服务起不来。\n\n"
      + "看是谁：lsof -nP -iTCP:\(port) -sTCP:LISTEN；关掉它之后点「重试」。"
  }
}
