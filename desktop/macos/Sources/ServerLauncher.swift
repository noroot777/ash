import Foundation

/// 服务没在跑时替用户把 :4317 起起来。
///
/// 起法与 `npm run restart` 的最后一步一致：在仓库根跑 `scripts/start-detached.mjs <日志> node
/// server/dist/index.js`，server 进新会话、脱离本进程 —— 退出 app 不会带走服务，更不会带走
/// 它名下在跑的 agent。这里**只负责起**，不 build、不杀旧进程：那是 restart.mjs 的事，两边各
/// 做一半才不会抢。
///
/// 环境走用户的交互式登录 shell（`zsh -ilc`）：从访达 / Dock 打开的 app 只有
/// `/usr/bin:/bin` 这类最小 PATH，而 server 要拉起的 claude、codex、kimi 装在 Homebrew 与
/// ~/.xxx/bin 里，PATH 在 .zprofile / .zshrc 里拼出来。跟终端里跑 restart 拿到的是同一份环境。
final class ServerLauncher {
  enum Outcome {
    case ready
    /// 正有 `npm run restart` 在换服务，不插手，等它起好。
    case restartInProgress
    case failed(String)
  }

  static let shared = ServerLauncher()

  /// 自动起服务只对本机地址有意义；连局域网别的 ash 时这个启动器不出手。
  var canLaunch: Bool {
    guard let host = AshConfig.baseURL.host?.lowercased() else { return false }
    return ["127.0.0.1", "localhost", "::1"].contains(host)
  }

  var logURL: URL {
    URL(fileURLWithPath: "/tmp/ash-\(AshConfig.baseURL.port ?? 4317).log")
  }

  private let queue = DispatchQueue(label: "dev.ash.server-launcher")
  private var running = false

  /// 确保服务在跑：通着就直接 ready；没通就起一个并等到 /api/health 应答。
  /// 回调在主线程。同一时刻只跑一次，重复调用直接丢掉（调用方各自在轮询 health）。
  func ensureRunning(timeout: TimeInterval = 45, completion: @escaping (Outcome) -> Void) {
    queue.async {
      guard !self.running else { return }
      self.running = true
      let outcome = self.ensureRunningSync(timeout: timeout)
      self.running = false
      DispatchQueue.main.async { completion(outcome) }
    }
  }

  func ensureRunningSync(timeout: TimeInterval) -> Outcome {
    if Self.isHealthy() { return .ready }
    // 跨进程互斥：开着的 app 和登录项可能同时发现服务不在。抢到锁再探一次，前一个起好的
    // 这时已经在应答，就不会再起第二份去撞 server 的单实例锁。
    let lock = open("/tmp/ash-mac-launch.lock", O_CREAT | O_RDWR, 0o600)
    if lock >= 0 { flock(lock, LOCK_EX) }
    defer { if lock >= 0 { flock(lock, LOCK_UN); close(lock) } }
    if Self.isHealthy() { return .ready }
    guard canLaunch else { return .failed("\(AshConfig.baseURL.absoluteString) 不是本机地址，不会替它启动服务。") }
    if Self.restartScriptRunning() { return waitHealthy(timeout: 120) ? .ready : .restartInProgress }

    guard let repo = AshConfig.repoURL else {
      return .failed("不知道 ash 仓库在哪。用 `defaults write dev.ash.mac AshRepoPath <仓库根>` 指一下。")
    }
    let entry = repo.appendingPathComponent("server/dist/index.js")
    guard FileManager.default.fileExists(atPath: entry.path) else {
      return .failed("\(entry.path) 不存在：仓库还没构建过，先在仓库里跑一次 npm run restart。")
    }

    let shell = Process()
    shell.executableURL = URL(fileURLWithPath: Self.loginShell())
    // 两个参数借环境变量递进去免得拼引号，exec 之前清掉，不漏进 server 和它拉起的 agent。
    shell.arguments = ["-ilc", #"cd "$ASH_MAC_REPO" && log="$ASH_MAC_LOG" && unset ASH_MAC_REPO ASH_MAC_LOG && exec node scripts/start-detached.mjs "$log" node server/dist/index.js"#]
    var env = Self.terminalLikeEnvironment()
    env["ASH_MAC_REPO"] = repo.path
    env["ASH_MAC_LOG"] = logURL.path
    // 默认端口不传 PORT：server 的环境会一路继承给 agent 与应用内终端，多一个 PORT 会让
    // 里面起的前端 dev server 去抢 ash 的端口。终端里跑 restart 时环境里也没有它。
    if let port = AshConfig.baseURL.port, port != 4317 { env["PORT"] = String(port) }
    shell.environment = env
    let stdout = Pipe()
    shell.standardOutput = stdout
    shell.standardError = FileHandle.nullDevice
    shell.standardInput = FileHandle.nullDevice
    do { try shell.run() } catch { return .failed("拉不起登录 shell：\(error.localizedDescription)") }

    // .zshrc 里万一有等输入的东西，别让启动器一起卡死。
    let deadline = Date().addingTimeInterval(20)
    while shell.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
    if shell.isRunning {
      shell.terminate()
      return .failed("登录 shell 20 秒没返回，可能是 .zshrc 在等输入。")
    }
    let pid = String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
      .components(separatedBy: .whitespacesAndNewlines).last { !$0.isEmpty }
    guard shell.terminationStatus == 0, let pid, Int(pid) != nil else {
      return .failed("启动命令失败（退出码 \(shell.terminationStatus)），看日志 \(logURL.path)。")
    }
    return waitHealthy(timeout: timeout)
      ? .ready
      : .failed("服务进程 \(pid) 起了，但 \(Int(timeout)) 秒内没应答 /api/health。看日志 \(logURL.path)。")
  }

  private func waitHealthy(timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if Self.isHealthy() { return true }
      Thread.sleep(forTimeInterval: 0.5)
    }
    return false
  }

  /// 同步探一次 /api/health。只在后台队列上调。
  static func isHealthy() -> Bool {
    var request = URLRequest(url: AshConfig.healthURL, timeoutInterval: 1.5)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    let done = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: request) { _, response, _ in
      ok = (response as? HTTPURLResponse)?.statusCode == 200
      done.signal()
    }.resume()
    done.wait()
    return ok
  }

  /// restart.mjs 杀掉旧 server 到拉起新 server 之间有个空窗；这时 app 再起一个，新旧两份会
  /// 撞单实例锁，restart 那边还会把应答的这份当成冒名者报失败。
  private static func restartScriptRunning() -> Bool {
    let pgrep = Process()
    pgrep.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    pgrep.arguments = ["-f", "scripts/restart.mjs"]
    pgrep.standardOutput = FileHandle.nullDevice
    pgrep.standardError = FileHandle.nullDevice
    guard (try? pgrep.run()) != nil else { return false }
    pgrep.waitUntilExit()
    return pgrep.terminationStatus == 0
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
