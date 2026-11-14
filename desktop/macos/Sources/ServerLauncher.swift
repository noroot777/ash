import Foundation

/// 把自带的那份 ash 服务起起来：用 bundle 里的 node 跑 bundle 里的 server，数据根交给
/// `ASH_DATA_DIR`，带 `ASH_LOCAL_ONLY=1`（只听 127.0.0.1、固定自用模式）。
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
    /// 端口被别的 ash / 别的程序占着。带着说给用户听的那段话：是谁、怎么办。
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

  var logURL: URL { AshConfig.serverLogURL }

  private let queue = DispatchQueue(label: "dev.ash.server-launcher")
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
    if let settled = Self.settle(AshHealth.probeSync()) { return settled }
    if let hold { return .failed(hold) }
    guard AshConfig.isLocal else {
      return .failed("连不上 \(AshConfig.baseURL.absoluteString)。它不是本机地址，app 不会替它启动服务。")
    }
    guard AshConfig.isDataInitialized || freshStartApproved else { return .needsSetup }
    let lock: ServerStartLock
    do {
      lock = try ServerStartLock(dataDir: AshConfig.dataURL)
      let deadline = Date().addingTimeInterval(timeout)
      while try !lock.tryAcquire() {
        if let settled = Self.settle(AshHealth.probeSync()) { return settled }
        if let hold { return .failed(hold) }
        guard Date() < deadline else { return .failed("等另一处启动 ash 服务超时。可以重试；服务起来后也会自动载入。") }
        Thread.sleep(forTimeInterval: 0.2)
      }
    } catch {
      return .failed("无法取得服务启动锁：\(error.localizedDescription)")
    }
    defer { withExtendedLifetime(lock) {} }
    if let settled = Self.settle(AshHealth.probeSync()) { return settled }
    if let hold { return .failed(hold) }
    if let failure = Self.backUpBeforeMigration() { return .failed(failure) }
    let parts = [AshConfig.nodeURL, AshConfig.serverEntryURL, AshConfig.detachScriptURL]
    if let missing = parts.first(where: { !FileManager.default.fileExists(atPath: $0.path) }) {
      return .failed("app 里自带的 ash 不完整（缺 \(missing.path)）。重新装一次 Ash.app。")
    }
    do {
      try FileManager.default.createDirectory(at: AshConfig.logURL, withIntermediateDirectories: true)
    } catch {
      return .failed("建不了日志目录 \(AshConfig.logURL.path)：\(error.localizedDescription)")
    }
    switch spawnDetached() {
    case .failure(let reason): return .failed(reason)
    case .success(let pid): return waitReady(pid: pid, timeout: timeout)
    }
  }

  /// 这份库上一次是别的构建号的 app 起的服务在用（或者不知道是谁）：这一版的 server 一起来就可能
  /// 迁移它，迁移不可逆。已经有固定着的恢复点（UpdateGate 装更新前留的，或者上一次在这里补的、
  /// 新版还没起来过）就不再备 —— 那份才是原件，这会儿的库可能已经被失败的迁移改过一半了。没有
  /// 的 —— 退出时没过闸就被 Sparkle 装上了、`build.sh --install`、手动换了 app —— 在这里补一份并
  /// 固定下来。备份不成就不起：库原样留着，配上旧版 app 还能回去。返回 nil = 可以起。
  private static func backUpBeforeMigration() -> String? {
    let db = AshConfig.dataURL.appendingPathComponent("ash.db")
    guard FileManager.default.fileExists(atPath: db.path) else { return nil }
    let record = ServerRecord.read()
    if record?.bundleVersion == AshConfig.bundleVersion { return nil }
    if DatabaseBackup.recoveryPoint() != nil { return nil }
    do {
      try DatabaseBackup.beforeUpdate(fromVersion: record?.bundleVersion ?? "unknown")
      return nil
    } catch {
      return "这一版要在库上做迁移，迁移前先备份库没成功（\(error.localizedDescription)），所以没起服务、库没动过。\n"
        + "腾出空间 / 修好权限后点「重试」；要回到旧版，把旧版 app 装回来就行（README「回到旧版」）。"
    }
  }

  /// 探到的结果里哪些已经是结论：自己那份在 → ready；别人占着 → occupied；连不上 → nil（接着起）。
  static func settle(_ probe: AshProbe) -> Outcome? {
    switch probe {
    case .down, .unreachable: return nil
    case .notAsh(let what): return .occupied(Occupant.notAsh(what))
    case .ash(let instance): return AshHealth.isServing(probe) ? .ready : .occupied(Occupant.otherAsh(instance))
    }
  }

  private enum Spawned { case success(Int32), failure(String) }

  private func spawnDetached() -> Spawned {
    let shell = Process()
    shell.executableURL = URL(fileURLWithPath: Self.loginShell())
    // 路径借环境变量递进去免得拼引号，exec 之前清掉，不漏进 server 和它拉起的 agent。
    // ASH_DATA_DIR / ASH_LOCAL_ONLY 是给 server 的，它读完就从自己的环境里删掉（见
    // server/src/paths.ts、local-only.ts），agent 同样拿不到。
    shell.arguments = ["-ilc", #"node="$ASH_MAC_NODE" detach="$ASH_MAC_DETACH" entry="$ASH_MAC_ENTRY" log="$ASH_MAC_LOG" && unset ASH_MAC_NODE ASH_MAC_DETACH ASH_MAC_ENTRY ASH_MAC_LOG && cd "$ASH_DATA_DIR" && exec "$node" "$detach" "$log" "$node" "$entry""#]
    var env = Self.terminalLikeEnvironment()
    env["ASH_MAC_NODE"] = AshConfig.nodeURL.path
    env["ASH_MAC_DETACH"] = AshConfig.detachScriptURL.path
    env["ASH_MAC_ENTRY"] = AshConfig.serverEntryURL.path
    env["ASH_MAC_LOG"] = logURL.path
    env["ASH_DATA_DIR"] = AshConfig.dataURL.path
    env["ASH_LOCAL_ONLY"] = "1"
    // 默认端口不传 PORT：server 的环境会一路继承给 agent 与应用内终端，多一个 PORT 会让
    // 里面起的前端 dev server 去抢 ash 的端口。
    if AshConfig.port != 4317 { env["PORT"] = String(AshConfig.port) }
    shell.environment = env
    let launchLog = AshConfig.logURL.appendingPathComponent("launch-\(UUID().uuidString).log")
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
      let probe = AshHealth.probeSync()
      if case .ash(let instance) = probe, instance.isOurs, instance.pid == Int(pid) {
        ServerRecord.write(pid: Int(pid))
        // 这一版的服务应答了 = 它的迁移跑完了：迁移前的原件不必再固定着。
        DatabaseBackup.releaseRecoveryPoint()
        return .ready
      }
      if case .ash(let instance) = probe, !instance.isOurs { return .occupied(Occupant.otherAsh(instance)) }
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

  private static func loginShell() -> String {
    if let pw = getpwuid(getuid()), let shell = pw.pointee.pw_shell { return String(cString: shell) }
    return "/bin/zsh"
  }
}

/// 「端口被占着」时说给用户听的那段话：是谁、怎么办。
enum Occupant {
  static func otherAsh(_ instance: AshInstance) -> String {
    let port = AshConfig.port
    let who = instance.pid.map { "进程 \($0)" } ?? "进程号不明"
    var lines = ["\(port) 端口上已经有一份 ash 在跑（\(who)），但它不是这个 app 的那份，所以没有连上去。"]
    if let codeDir = instance.codeDir, let dataDir = instance.dataDir {
      lines.append("代码：\(codeDir)\n数据：\(dataDir)")
      if FileManager.default.fileExists(atPath: URL(fileURLWithPath: codeDir).appendingPathComponent(".git").path) {
        lines.append("这是仓库里起的开发实例（npm run restart）。")
      }
    } else {
      lines.append("它没报自己的代码和数据在哪（比这个 app 旧的版本），认不出来历。")
    }
    let stop = instance.pid.map { "kill \($0)" } ?? "lsof -nP -iTCP:\(port) -sTCP:LISTEN 找到它再停"
    lines.append("要用 app：先停掉它（\(stop)），再点「重试」。开发实例以后换个端口起，例如 PORT=14317 npm run restart。")
    return lines.joined(separator: "\n\n")
  }

  static func notAsh(_ what: String) -> String {
    let port = AshConfig.port
    return "\(port) 端口被别的程序占着（它应答了 \(what)，不是 ash），ash 服务起不来。\n\n"
      + "看是谁：lsof -nP -iTCP:\(port) -sTCP:LISTEN；关掉它之后点「重试」。"
  }
}
