import Foundation
import Darwin

/// 这个 app 连哪台、自带的那份 Navi 在 bundle 里哪儿、数据和日志放哪。
///
/// 环境变量那几个口子是给验证用的：把 app 拷到别处、用临时数据根和临时端口起一份，碰不到
/// 日常那一份（`NAVI_URL` + `NAVI_DATA_DIR` 就够了；`NAVI_MAC_RUNTIME` / `NAVI_MAC_DOWNLOAD_JOURNAL`
/// 只给回归测试换成假的）。改名前的旧名照样认，新名优先（`LegacyIdentity.environment`）。
enum NaviConfig {
  private static let environment = ProcessInfo.processInfo.environment
  private static func env(_ name: String) -> String? { LegacyIdentity.environment(name, in: environment) }

  /// 新旧两代变量指着不同的服务或数据根：说不清该开哪一份，入口据此拒绝打开（见 main.swift）。
  static var environmentConflict: String? {
    ["NAVI_URL", "NAVI_DATA_DIR"].lazy.compactMap { LegacyIdentity.environmentConflict($0, in: environment) }.first
  }

  /// 优先级：环境变量 NAVI_URL > `defaults write dev.navi.mac NaviURL <url>` > 本机 4317。
  static let baseURL: URL = {
    for raw in [env("NAVI_URL"), UserDefaults.standard.string(forKey: "NaviURL")] {
      if let raw, let url = URL(string: raw.trimmingCharacters(in: .whitespaces)), url.host != nil {
        return url
      }
    }
    return URL(string: "http://127.0.0.1:4317")!
  }()

  static var healthURL: URL { baseURL.appendingPathComponent("api/health") }
  static var port: Int { port(of: baseURL) }

  /// 本机那份服务给窗口专用的端口（server/src/window-port.ts）。窗口只连它，4317 留给浏览器、CLI
  /// 和 MCP：app 的服务一停，这个端口就空着，另一份 navi（不管新旧）接手的只会是 4317，页面在撤下
  /// 之前发出的请求连不到它。按数据根的真实路径算一个固定值，避开系统的临时端口段（49152 起）：
  /// 每次起服务都是同一个端口，页面的本地设置（主题、草稿）跟着这个地址留得住。
  static let windowPort: Int = {
    if let raw = env("NAVI_MAC_WINDOW_PORT"), let port = Int(raw), (1...65535).contains(port) { return port }
    var hash: UInt32 = 2_166_136_261
    for byte in NaviHealth.realPath(dataURL.path).utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
    return 42_000 + Int(hash % 6_000)
  }()

  /// 窗口载的地址：本机时是专用端口，连别处的 navi 时就是那个地址。
  static var windowURL: URL {
    guard isLocal else { return baseURL }
    return URL(string: "http://127.0.0.1:\(windowPort)")!
  }
  static var windowHealthURL: URL { windowURL.appendingPathComponent("api/health") }

  /// 窗口地址换回给浏览器用的地址（同一路由，4317 那一边）。
  static func browserURL(for url: URL) -> URL {
    guard isLocal, isSameOrigin(url), var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
    parts.scheme = baseURL.scheme
    parts.host = baseURL.host
    parts.port = baseURL.port
    return parts.url ?? baseURL
  }

  /// 菜单里的「允许其他设备访问」。关着（默认）时 app 带着本机自用模式起服务：只听 127.0.0.1，
  /// 没有远程配对和访问密钥；开着时不带 —— 服务听所有网卡，同一 Tailscale / 局域网里的设备经配对或
  /// 访问密钥进来（手机上点飞书卡片打得开）。服务按起的那一下的值定，改了要重启（RemoteAccessSwitch）。
  static var allowsOtherDevices: Bool {
    get { UserDefaults.standard.bool(forKey: "NaviAllowOtherDevices") }
    set { UserDefaults.standard.set(newValue, forKey: "NaviAllowOtherDevices") }
  }

  /// 本机地址才有「自己起、认是不是自己那份」这回事；连局域网别的 navi 时 app 只是个窗口。
  static var isLocal: Bool { loopback.contains(baseURL.host?.lowercased() ?? "") }

  /// 自带的那份 navi（`scripts/bundle-runtime.mjs` 装进来的，布局见那份脚本顶部）。
  static var runtimeURL: URL {
    RuntimeStore.restored ?? RuntimeStore.destination ?? bundledRuntimeURL
  }
  static var bundledRuntimeURL: URL {
    if let raw = env("NAVI_MAC_RUNTIME") { return URL(fileURLWithPath: raw, isDirectory: true) }
    return Bundle.main.resourceURL!.appendingPathComponent("app", isDirectory: true)
  }
  static var nodeURL: URL { runtimeURL.appendingPathComponent("node/bin/node") }
  static var serverEntryURL: URL { runtimeURL.appendingPathComponent("server/dist/index.js") }
  static var detachScriptURL: URL { runtimeURL.appendingPathComponent("scripts/start-detached.mjs") }
  /// 导入旧数据时洗副本的那一段（server/src/import-snapshot.ts）。
  static var importToolURL: URL { runtimeURL.appendingPathComponent("server/dist/import-snapshot-cli.js") }

  /// 正式那份是 dev.navi.mac（改名前是 dev.ash.mac，接班见 LegacyIdentity）。演练用的 app 换一个
  /// （build.sh 的 NAVI_MAC_BUNDLE_ID），defaults、数据根、登录项就都跟日常那份分开；测试驱动不是 bundle，
  /// 退回正式那个名字。
  static var bundleID: String { Bundle.main.bundleIdentifier ?? LegacyIdentity.successor }

  /// 这份 app 的构建号（CFBundleVersion，单调递增，Sparkle 比的就是它）。
  static var bundleVersion: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "dev"
  }

  /// app 自己的那块地。从 Ash.app 升级上来的机器上还是改名前那块（dev.ash.mac），见 LegacyIdentity。
  static var supportURL: URL {
    LegacyIdentity.supportDirectory(
      in: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0], bundleID: bundleID)
  }

  /// server 的数据根（库、runs、uploads……整份交给 `NAVI_DATA_DIR`）。缺省就是 app 自己那块地；
  /// `NAVI_DATA_DIR` 或 `defaults write dev.navi.mac NaviDataDir <目录>` 可以改指。
  static let dataURL: URL = {
    let raw = env("NAVI_DATA_DIR")
      ?? UserDefaults.standard.string(forKey: "NaviDataDir").flatMap { $0.isEmpty ? nil : $0 }
    return raw.map { URL(fileURLWithPath: $0, isDirectory: true).standardizedFileURL } ?? supportURL
  }()

  /// 数据根里还没有库 = 这个数据目录第一次用：先问「全新开始」还是「导入已有数据」，再起服务。
  static var isDataInitialized: Bool { DatabaseFile.isInitialized(dataURL) }

  /// 日志跟着数据根走（`<数据根>/logs`）：换临时数据根验证时不会混进日常那一份的日志里。
  static var logURL: URL { dataURL.appendingPathComponent("logs", isDirectory: true) }
  static var serverLogURL: URL { logURL.appendingPathComponent("server.log") }

  /// 更新前的库备份（见 DatabaseBackup）。
  static var backupURL: URL { dataURL.appendingPathComponent("backups", isDirectory: true) }

  /// 下载事务的登记放哪（见 DownloadTransaction）。
  static var downloadJournalURL: URL {
    if let raw = env("NAVI_MAC_DOWNLOAD_JOURNAL") { return URL(fileURLWithPath: raw, isDirectory: true) }
    return supportURL.appendingPathComponent("downloads", isDirectory: true)
  }

  /// 窗口的同源判据：scheme + host + port 跟窗口地址逐字一样。本机时**不认别名**：localhost、::1、
  /// 4317 都不是窗口那一份，交给浏览器打开 —— 窗口只跟专用端口说话，实例号的 cookie 也只绑在这一处。
  /// 连别处的 navi 时 127.0.0.1 与 localhost 视为同一台，免得服务端回跳到另一种写法时被踢去浏览器。
  static func isSameOrigin(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), scheme == windowURL.scheme?.lowercased() else { return false }
    let host = url.host?.lowercased() ?? ""
    let windowHost = windowURL.host?.lowercased() ?? ""
    let hostMatches = host == windowHost || (!isLocal && loopback.contains(host) && loopback.contains(windowHost))
    return hostMatches && port(of: url) == port(of: windowURL)
  }

  private static let loopback: Set<String> = ["127.0.0.1", "localhost", "::1"]

  private static func port(of url: URL) -> Int {
    url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80)
  }
}

/// 数据目录里的库叫什么、认哪一份。口径同 server/src/db/path.ts：新名 `navi.db`；改名之前的安装是 `ash.db`，停机时
/// `npm run rename-db` 改名，改完在原地留一份路标（不是 SQLite 库，改名之前的服务对着它起不来）。
enum DatabaseFile {
  static let name = "navi.db"
  static let movedMarker = "NAVI-DB-MOVED"
  static let renameJournal = "navi.db.renaming"
  /// 跟着库名走的状态文件（scripts/db-file.mjs 的 DB_CARRIED_SUFFIXES 去掉 SQLite 自己那三个）：导入改名之前的
  /// 数据时跟着库一起换成新名，不然接力身份、远程访问密钥在新库旁边找不到。
  static let carriedSuffixes = [".exits.jsonl", ".exits.jsonl.1", ".stall-verdicts.jsonl", ".stall-verdicts.jsonl.1",
                                ".identity.json", ".remote-access.json", ".feishu.json"]
  /// 两代库名下的 SQLite 自带文件：库走在线备份另拷，这些不跟着复制。
  static let sqliteFiles: Set<String> = Set([name, LegacyIdentity.databaseFile].flatMap { [$0, "\($0)-wal", "\($0)-shm", "\($0)-journal"] })

  enum Choice: Equatable {
    case current(URL), legacy(URL), none
    /// 认不准（两份都是库 / 只剩路标 / 上次改名没做完）：说清怎么办，不替人选。
    case unclear(String)

    var url: URL? {
      switch self {
      case .current(let url), .legacy(let url): return url
      case .none, .unclear: return nil
      }
    }
  }

  /// 旧名那一份是不是一份库（在、而且不是路标）。
  static func isLegacyDatabase(_ url: URL) -> Bool {
    guard let handle = FileHandle(forReadingAtPath: url.path) else { return FileManager.default.fileExists(atPath: url.path) }
    defer { try? handle.close() }
    let head = (try? handle.read(upToCount: movedMarker.utf8.count)) ?? Data()
    return head != Data(movedMarker.utf8)
  }

  static func choose(in dir: URL) -> Choice {
    let fm = FileManager.default
    let current = dir.appendingPathComponent(name), legacy = dir.appendingPathComponent(LegacyIdentity.databaseFile)
    if fm.fileExists(atPath: dir.appendingPathComponent(renameJournal).path) {
      return .unclear("\(dir.path) 里的库改名上次没做完（\(renameJournal) 还在）。停着服务跑 `npm run rename-db -- --apply` 做完它，或 `-- --rollback` 退回去。")
    }
    let hasLegacy = fm.fileExists(atPath: legacy.path)
    if fm.fileExists(atPath: current.path) {
      if hasLegacy && isLegacyDatabase(legacy) {
        return .unclear("\(dir.path) 里 \(name) 和 \(LegacyIdentity.databaseFile) 都是库，分不清哪份是在用的。把不要的那份挪出去再来。")
      }
      return .current(current)
    }
    if hasLegacy {
      return isLegacyDatabase(legacy) ? .legacy(legacy)
        : .unclear("\(dir.path) 里的 \(LegacyIdentity.databaseFile) 是改名留下的路标，但 \(name) 不在。")
    }
    return .none
  }

  struct Unclear: LocalizedError {
    let errorDescription: String?
  }

  /// 服务开着的（或会开的）那份库：给它留底、找它的锁。没有库是 nil；认不准时抛出原因 —— 「有库但分不清是哪份」
  /// 跟「从没用过」不是一回事，留底、更新前备份不能把它当成没东西可备就放过去。只认一次：认两次，中间目录一变，
  /// 第二次的「认不准」就成了 nil、被当成没有库。
  static func existing(in dir: URL) throws -> URL? {
    let choice = choose(in: dir)
    if case .unclear(let why) = choice { throw Unclear(errorDescription: why) }
    return choice.url
  }

  /// 这个数据目录用过没有：两代库名、改名账本，有一样就算 —— 认不准的情形交给服务起来时说清楚，不当成第一次用。
  static func isInitialized(_ dir: URL) -> Bool {
    [name, LegacyIdentity.databaseFile, renameJournal].contains { FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path) }
  }

  /// 这份库的单例锁，两代名字（新版服务两份都写，改名之前的只写旧名）。
  static func lockFiles(of db: URL) -> [URL] {
    [".navi.lock", LegacyIdentity.singletonLockSuffix].map { URL(fileURLWithPath: db.path + $0) }
  }
}

enum RuntimeStore {
  private static let lock = NSLock()
  private static var prepared = false
  private static var reclaimed = Set<Int>()
  static var restored: URL?
  static var root: URL { NaviConfig.dataURL.appendingPathComponent(".mac-runtimes", isDirectory: true) }

  static func identifier(at url: URL) -> String? {
    guard let data = try? Data(contentsOf: url.appendingPathComponent(".runtime.json")),
          let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          manifest["format"] as? Int == 1, let id = manifest["id"] as? String,
          id.count == 64, id.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { return nil }
    return id
  }

  static var destination: URL? {
    identifier(at: NaviConfig.bundledRuntimeURL).map { root.appendingPathComponent($0, isDirectory: true) }
  }

  static func contains(_ path: String) -> Bool {
    let url = URL(fileURLWithPath: path, isDirectory: true)
    guard let id = identifier(at: url), url.lastPathComponent == id else { return false }
    return NaviHealth.samePath(path, root.appendingPathComponent(id).path)
  }

  static func prepare() throws {
    lock.lock()
    defer { lock.unlock() }
    if prepared { return }
    let source = NaviConfig.bundledRuntimeURL
    let manifest = source.appendingPathComponent(".runtime.json")
    guard FileManager.default.fileExists(atPath: manifest.path) else {
      if Bundle.main.resourceURL?.appendingPathComponent("app").path == source.path {
        throw SQLiteFile.Failure("app 缺少运行时清单，请重新安装。")
      }
      return
    }
    guard destination != nil else { throw SQLiteFile.Failure("app 的运行时清单损坏。") }
    let process = Process()
    process.executableURL = source.appendingPathComponent("node/bin/node")
    process.arguments = [source.appendingPathComponent("scripts/runtime-store.mjs").path, "install", source.path, root.path]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    let errors = Pipe()
    process.standardError = errors
    try process.run()
    let detail = errors.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      throw SQLiteFile.Failure("准备独立运行时失败：\(String(data: detail, encoding: .utf8) ?? "")")
    }
    prepared = true
  }

  static func activate(_ runtime: URL) throws {
    guard contains(runtime.path) else { throw SQLiteFile.Failure("恢复运行时身份不符") }
    let process = Process()
    process.executableURL = NaviConfig.bundledRuntimeURL.appendingPathComponent("node/bin/node")
    process.arguments = [NaviConfig.bundledRuntimeURL.appendingPathComponent("scripts/runtime-store.mjs").path,
                         "activate", runtime.path, root.path]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw SQLiteFile.Failure("恢复运行时校验失败") }
    restored = runtime
  }

  static func reclaim() {
    let process = Process()
    process.executableURL = NaviConfig.bundledRuntimeURL.appendingPathComponent("node/bin/node")
    process.arguments = [NaviConfig.bundledRuntimeURL.appendingPathComponent("scripts/runtime-store.mjs").path, "gc", root.path]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    if (try? process.run()) != nil { process.waitUntilExit() }
  }

  static func reclaimAfterConfirmation(_ instance: NaviInstance) {
    guard instance.isOurs, let pid = instance.pid, let code = instance.codeDir, contains(code) else { return }
    lock.lock()
    let first = reclaimed.insert(pid).inserted
    lock.unlock()
    if first { DispatchQueue.global(qos: .utility).async { reclaim() } }
  }

  static func lockForReplacement() throws -> Int32 {
    let file = NaviConfig.bundledRuntimeURL.appendingPathComponent(".in-use")
    let descriptor = open(file.path, O_RDONLY | O_CLOEXEC)
    guard descriptor >= 0 else { throw SQLiteFile.Failure("打不开 app 的运行时代码锁。") }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
      close(descriptor)
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
      process.arguments = ["-nP", "-w", "-F", "pc", "--", file.path]
      let output = Pipe()
      process.standardOutput = output
      process.standardError = FileHandle.nullDevice
      var blockers = "（查不到持锁进程）"
      if (try? process.run()) != nil {
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let lines = String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init)
        if !lines.isEmpty { blockers = lines.map { $0.hasPrefix("p") ? "PID \($0.dropFirst())" : String($0.dropFirst()) }.joined(separator: " ") }
      }
      throw SQLiteFile.Failure("app 内的代码仍被以下进程使用：\(blockers)\n这次未替换 app，也未停止服务。\n\n在「检查 Navi MCP 登记…」中把终端的登记迁到固定外置入口，再重开列出的 CLI 会话：\ncommand = /bin/sh\nargs = [\(root.appendingPathComponent("mcp.sh").path)]\n旧进程退出后再试更新；这条入口以后跟随新版服务，不再占用 app 包。")
    }
    do { try BundleRuntimeUse.verify() }
    catch { close(descriptor); throw error }
    return descriptor
  }
}
