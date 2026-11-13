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

  /// app 自己的那块地。
  static var supportURL: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("dev.ash.mac", isDirectory: true)
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

  /// 下载事务的登记放哪（见 DownloadTransaction）。
  static var downloadJournalURL: URL {
    if let raw = env["ASH_MAC_DOWNLOAD_JOURNAL"], !raw.isEmpty { return URL(fileURLWithPath: raw, isDirectory: true) }
    return supportURL.appendingPathComponent("downloads", isDirectory: true)
  }

  /// 同源判据：scheme + host + port。127.0.0.1 与 localhost 视为同一台，免得服务端回跳
  /// 到另一种写法时被当成外链踢去浏览器。
  static func isSameOrigin(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), scheme == baseURL.scheme?.lowercased() else { return false }
    let host = url.host?.lowercased() ?? ""
    let baseHost = baseURL.host?.lowercased() ?? ""
    let hostMatches = host == baseHost || (loopback.contains(host) && loopback.contains(baseHost))
    return hostMatches && port(of: url) == port(of: baseURL)
  }

  private static let loopback: Set<String> = ["127.0.0.1", "localhost", "::1"]

  private static func port(of url: URL) -> Int {
    url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80)
  }
}
