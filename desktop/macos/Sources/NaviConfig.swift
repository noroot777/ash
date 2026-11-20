import Foundation
import CryptoKit
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
    (try? RuntimeStore.selected.get()) ?? bundledRuntimeURL
  }
  static var bundledRuntimeURL: URL {
    if let raw = env("NAVI_MAC_RUNTIME") { return URL(fileURLWithPath: raw, isDirectory: true) }
    return Bundle.main.resourceURL!.appendingPathComponent("app", isDirectory: true)
  }
  static var runtimeStoreURL: URL { dataURL.appendingPathComponent(".runtimes", isDirectory: true) }
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
  struct Envelope: Decodable { let id: String; let payload: String }
  struct Manifest: Decodable {
    struct Entry: Decodable {
      let path: String
      let sha: String?
      let executable: Bool?
      let link: String?
    }
    let `protocol`: Int
    let schema: String
    let files: [Entry]
  }
  struct Failure: LocalizedError { let errorDescription: String?; init(_ text: String) { errorDescription = text } }
  static let manifestName = "runtime-manifest.json"
  static let selected: Result<URL, Error> = Result { try prepare(NaviConfig.bundledRuntimeURL) }
  private static var lease: Int32 = -1
  private static var bundleLease: Int32 = -1

  static func protectBundleUpdate() throws {
    guard FileManager.default.fileExists(atPath: NaviConfig.bundledRuntimeURL.appendingPathComponent(manifestName).path), bundleLease < 0 else { return }
    let descriptor = open(NaviConfig.bundledRuntimeURL.appendingPathComponent(".in-use").path, O_RDONLY | O_EXLOCK | O_NONBLOCK | O_CLOEXEC)
    guard descriptor >= 0 else { throw Failure("仍有进程使用 app 内的旧代码，首次迁移需等待它们退出，未放行换包。") }
    let resources = NaviConfig.bundledRuntimeURL.deletingLastPathComponent()
    let scan = Process()
    scan.executableURL = URL(fileURLWithPath: "/bin/bash")
    scan.arguments = [resources.appendingPathComponent("bundle-users.sh").path, resources.deletingLastPathComponent().deletingLastPathComponent().path]
    let output = Pipe()
    scan.standardOutput = output
    scan.standardError = FileHandle.nullDevice
    do {
      try scan.run()
      let data = output.fileHandleForReading.readDataToEndOfFile()
      scan.waitUntilExit()
      let users = String(decoding: data, as: UTF8.self).split(separator: "\n").filter { !sparkleInstaller($0, resources: resources) }
      guard scan.terminationStatus == 0, users.isEmpty else { throw Failure("仍有进程使用 app 包或无法确认：\(users.joined(separator: "\n"))") }
      bundleLease = descriptor
    } catch { close(descriptor); throw error }
  }

  private static func sparkleInstaller(_ line: Substring, resources: URL) -> Bool {
    guard let word = line.split(whereSeparator: { $0.isWhitespace }).first, let pid = Int32(word), pid > 1 else { return false }
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return false }
    let actual = NaviHealth.realPath(String(cString: buffer))
    let framework = resources.deletingLastPathComponent().appendingPathComponent("Frameworks/Sparkle.framework/Versions/Current")
    return ["Autoupdate", "Updater.app/Contents/MacOS/Updater",
      "XPCServices/InstallerLauncher.xpc/Contents/MacOS/InstallerLauncher"].contains {
      actual == NaviHealth.realPath(framework.appendingPathComponent($0).path)
    }
  }

  static func releaseBundleUpdate() {
    if bundleLease >= 0 { close(bundleLease); bundleLease = -1 }
  }

  static func manifest(_ root: URL) throws -> (Envelope, Manifest) {
    let envelope = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: root.appendingPathComponent(manifestName)))
    guard envelope.id == digest(Data(envelope.payload.utf8)) else { throw Failure("运行时清单指纹不符") }
    let manifest = try JSONDecoder().decode(Manifest.self, from: Data(envelope.payload.utf8))
    guard manifest.protocol == 1, manifest.schema.count == 64 else { throw Failure("不支持的运行时接管协议") }
    return (envelope, manifest)
  }

  static func managed(_ path: String) -> Bool {
    let root = URL(fileURLWithPath: NaviHealth.realPath(path), isDirectory: true)
    guard NaviHealth.samePath(root.deletingLastPathComponent().path, NaviConfig.runtimeStoreURL.path),
          let (envelope, _) = try? manifest(root) else { return false }
    return root.lastPathComponent == envelope.id
  }

  static func compatible(_ path: String) -> Bool {
    guard managed(path), let (_, old) = try? manifest(URL(fileURLWithPath: path)),
          let (_, next) = try? manifest(NaviConfig.runtimeURL) else { return false }
    return old.protocol == next.protocol && old.schema == next.schema
  }

  private static func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private static func verify(_ root: URL, _ manifest: Manifest) throws {
    let lock = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent(".in-use").path)
    guard lock[.type] as? FileAttributeType == .typeRegular, (lock[.size] as? NSNumber)?.intValue == 0 else {
      throw Failure("运行时使用锁不是有效的空文件")
    }
    var expected = Set<String>()
    for entry in manifest.files {
      guard !entry.path.isEmpty, !entry.path.hasPrefix("/"), !entry.path.split(separator: "/").contains(".."),
            expected.insert(entry.path).inserted else { throw Failure("运行时清单路径无效") }
      let file = root.appendingPathComponent(entry.path)
      let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
      if let link = entry.link {
        guard attributes[.type] as? FileAttributeType == .typeSymbolicLink,
              try FileManager.default.destinationOfSymbolicLink(atPath: file.path) == link,
              !link.hasPrefix("/"),
              NaviHealth.realPath(file.path).hasPrefix(NaviHealth.realPath(root.path) + "/") else {
          throw Failure("运行时软链越界或损坏：\(entry.path)")
        }
      } else {
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              digest(try Data(contentsOf: file, options: .mappedIfSafe)) == entry.sha,
              (((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o111 != 0) == entry.executable else {
          throw Failure("运行时文件校验失败：\(entry.path)")
        }
      }
    }
    let canonicalRoot = URL(fileURLWithPath: NaviHealth.realPath(root.path), isDirectory: true)
    let prefix = canonicalRoot.path + "/"
    guard let entries = FileManager.default.enumerator(at: canonicalRoot, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]) else {
      throw Failure("无法枚举运行时文件")
    }
    var actual = Set<String>()
    for case let file as URL in entries {
      let values = try file.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
      if values.isDirectory == true && values.isSymbolicLink != true { continue }
      guard file.path.hasPrefix(prefix) else { throw Failure("运行时枚举路径越界") }
      let rel = String(file.path.dropFirst(prefix.count))
      if rel != manifestName && rel != ".in-use" { actual.insert(rel) }
    }
    guard expected == actual else {
      throw Failure("运行时文件集合不符；缺少：\(expected.subtracting(actual).sorted().prefix(8))；多出：\(actual.subtracting(expected).sorted().prefix(8))")
    }
  }

  private static func storeLock() throws -> Int32 {
    try FileManager.default.createDirectory(at: NaviConfig.runtimeStoreURL, withIntermediateDirectories: true)
    let descriptor = open(NaviConfig.runtimeStoreURL.appendingPathComponent(".store-lock").path,
                          O_CREAT | O_RDWR | O_EXLOCK | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { throw Failure("无法锁定运行时仓库") }
    return descriptor
  }

  private static func prepare(_ source: URL) throws -> URL {
    let files = FileManager.default
    if !files.fileExists(atPath: source.appendingPathComponent(manifestName).path),
       ProcessInfo.processInfo.environment["NAVI_MAC_RUNTIME"] != nil { return source }
    let (envelope, manifest) = try self.manifest(source)
    let lock = try storeLock()
    defer { close(lock) }
    let target = NaviConfig.runtimeStoreURL.appendingPathComponent(envelope.id, isDirectory: true)
    if !files.fileExists(atPath: target.path) {
      let staging = NaviConfig.runtimeStoreURL.appendingPathComponent(".staging-" + UUID().uuidString)
      defer { try? files.removeItem(at: staging) }
      try files.copyItem(at: source, to: staging)
      try verify(staging, manifest)
      try files.moveItem(at: staging, to: target)
    } else { try verify(target, manifest) }
    lease = open(target.appendingPathComponent(".in-use").path, O_RDONLY | O_SHLOCK | O_NONBLOCK | O_CLOEXEC)
    guard lease >= 0 else { throw Failure("无法持有运行时使用锁") }
    return target
  }

  static func reclaim() {
    guard let current = try? selected.get(), managed(current.path), let lock = try? storeLock() else { return }
    defer { close(lock) }
    let files = FileManager.default
    let entries = (try? files.contentsOfDirectory(at: NaviConfig.runtimeStoreURL, includingPropertiesForKeys: nil)) ?? []
    for root in entries where root != current && managed(root.path) {
      if files.fileExists(atPath: NaviConfig.runtimeStoreURL.appendingPathComponent(".host-pin-" + root.lastPathComponent).path) { continue }
      let descriptor = open(root.appendingPathComponent(".in-use").path, O_RDONLY | O_EXLOCK | O_NONBLOCK | O_CLOEXEC)
      guard descriptor >= 0 else { continue }
      defer { close(descriptor) }
      let scan = Process()
      scan.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
      scan.arguments = ["-nP", "-w", "+D", root.path, "-F", "p"]
      let output = Pipe()
      scan.standardOutput = output
      scan.standardError = FileHandle.nullDevice
      do {
        try scan.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        scan.waitUntilExit()
        let users = (String(data: data, encoding: .utf8) ?? "").split(separator: "\n")
          .filter { $0.hasPrefix("p") && $0 != "p\(getpid())" }
        guard scan.terminationStatus == 1 || scan.terminationStatus == 0, users.isEmpty else { continue }
        try files.removeItem(at: root)
      } catch {}
    }
  }
}
