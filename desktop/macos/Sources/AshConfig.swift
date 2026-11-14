import Foundation

/// 这个 app 连哪台、自带的那份 ash 在 bundle 里哪儿、数据和日志放哪。
///
/// 环境变量那几个口子是给验证用的：把 app 拷到别处、用临时数据根和临时端口起一份，碰不到
/// 日常那一份（`ASH_URL` + `ASH_DATA_DIR` 就够了；`ASH_MAC_RUNTIME` / `ASH_MAC_DOWNLOAD_JOURNAL`
/// 只给回归测试换成假的）。
enum AshConfig {
  private static let env = ProcessInfo.processInfo.environment

  /// 优先级：环境变量 ASH_URL > `defaults write dev.ash.mac AshURL <url>` > 本机 4317。
  static let baseURL: URL = {
    for raw in [env["ASH_URL"], UserDefaults.standard.string(forKey: "AshURL")] {
      if let raw, let url = URL(string: raw.trimmingCharacters(in: .whitespaces)), url.host != nil {
        return url
      }
    }
    return URL(string: "http://127.0.0.1:4317")!
  }()

  static var healthURL: URL { baseURL.appendingPathComponent("api/health") }
  static var port: Int { port(of: baseURL) }

  /// 本机那份服务给窗口专用的端口（server/src/window-port.ts）。窗口只连它，4317 留给浏览器、CLI
  /// 和 MCP：app 的服务一停，这个端口就空着，另一份 ash（不管新旧）接手的只会是 4317，页面在撤下
  /// 之前发出的请求连不到它。按数据根的真实路径算一个固定值，避开系统的临时端口段（49152 起）：
  /// 每次起服务都是同一个端口，页面的本地设置（主题、草稿）跟着这个地址留得住。
  static let windowPort: Int = {
    if let raw = env["ASH_MAC_WINDOW_PORT"], let port = Int(raw), (1...65535).contains(port) { return port }
    var hash: UInt32 = 2_166_136_261
    for byte in AshHealth.realPath(dataURL.path).utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
    return 42_000 + Int(hash % 6_000)
  }()

  /// 窗口载的地址：本机时是专用端口，连别处的 ash 时就是那个地址。
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

  /// 本机地址才有「自己起、认是不是自己那份」这回事；连局域网别的 ash 时 app 只是个窗口。
  static var isLocal: Bool { loopback.contains(baseURL.host?.lowercased() ?? "") }

  /// 自带的那份 ash（`scripts/bundle-runtime.mjs` 装进来的，布局见那份脚本顶部）。
  static var runtimeURL: URL {
    if let raw = env["ASH_MAC_RUNTIME"], !raw.isEmpty { return URL(fileURLWithPath: raw, isDirectory: true) }
    return Bundle.main.resourceURL!.appendingPathComponent("app", isDirectory: true)
  }
  static var nodeURL: URL { runtimeURL.appendingPathComponent("node/bin/node") }
  static var serverEntryURL: URL { runtimeURL.appendingPathComponent("server/dist/index.js") }
  static var detachScriptURL: URL { runtimeURL.appendingPathComponent("scripts/start-detached.mjs") }
  /// 导入旧数据时洗副本的那一段（server/src/import-snapshot.ts）。
  static var importToolURL: URL { runtimeURL.appendingPathComponent("server/dist/import-snapshot-cli.js") }

  /// 正式那份是 dev.ash.mac。演练用的 app 换一个（build.sh 的 ASH_MAC_BUNDLE_ID），defaults、
  /// 数据根、登录项就都跟日常那份分开；测试驱动不是 bundle，退回正式那个名字。
  static var bundleID: String { Bundle.main.bundleIdentifier ?? "dev.ash.mac" }

  /// 这份 app 的构建号（CFBundleVersion，单调递增，Sparkle 比的就是它）。
  static var bundleVersion: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "dev"
  }

  /// app 自己的那块地。
  static var supportURL: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent(bundleID, isDirectory: true)
  }

  /// server 的数据根（库、runs、uploads……整份交给 `ASH_DATA_DIR`）。缺省就是 app 自己那块地；
  /// `ASH_DATA_DIR` 或 `defaults write dev.ash.mac AshDataDir <目录>` 可以改指。
  static let dataURL: URL = {
    let raw = env["ASH_DATA_DIR"].flatMap { $0.isEmpty ? nil : $0 }
      ?? UserDefaults.standard.string(forKey: "AshDataDir").flatMap { $0.isEmpty ? nil : $0 }
    return raw.map { URL(fileURLWithPath: $0, isDirectory: true).standardizedFileURL } ?? supportURL
  }()

  /// 数据根里还没有库 = 这个数据目录第一次用：先问「全新开始」还是「导入已有数据」，再起服务。
  static var isDataInitialized: Bool {
    FileManager.default.fileExists(atPath: dataURL.appendingPathComponent("ash.db").path)
  }

  /// 日志跟着数据根走（`<数据根>/logs`）：换临时数据根验证时不会混进日常那一份的日志里。
  static var logURL: URL { dataURL.appendingPathComponent("logs", isDirectory: true) }
  static var serverLogURL: URL { logURL.appendingPathComponent("server.log") }

  /// 更新前的库备份（见 DatabaseBackup）。
  static var backupURL: URL { dataURL.appendingPathComponent("backups", isDirectory: true) }

  /// 下载事务的登记放哪（见 DownloadTransaction）。
  static var downloadJournalURL: URL {
    if let raw = env["ASH_MAC_DOWNLOAD_JOURNAL"], !raw.isEmpty { return URL(fileURLWithPath: raw, isDirectory: true) }
    return supportURL.appendingPathComponent("downloads", isDirectory: true)
  }

  /// 窗口的同源判据：scheme + host + port 跟窗口地址逐字一样。本机时**不认别名**：localhost、::1、
  /// 4317 都不是窗口那一份，交给浏览器打开 —— 窗口只跟专用端口说话，实例号的 cookie 也只绑在这一处。
  /// 连别处的 ash 时 127.0.0.1 与 localhost 视为同一台，免得服务端回跳到另一种写法时被踢去浏览器。
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
