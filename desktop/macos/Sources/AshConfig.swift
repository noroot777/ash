import Foundation

/// 壳连哪台 ash。壳只是 :4317 那份 web 的窗口，服务端的启停仍归 `npm run restart`，
/// 这里不拉起、不重启任何进程。
enum AshConfig {
  /// 优先级：环境变量 ASH_URL > `defaults write dev.ash.mac AshURL <url>` > 本机 4317。
  static let baseURL: URL = {
    let candidates = [
      ProcessInfo.processInfo.environment["ASH_URL"],
      UserDefaults.standard.string(forKey: "AshURL"),
    ]
    for raw in candidates {
      if let raw, let url = URL(string: raw.trimmingCharacters(in: .whitespaces)), url.host != nil {
        return url
      }
    }
    return URL(string: "http://127.0.0.1:4317")!
  }()

  static var healthURL: URL { baseURL.appendingPathComponent("api/health") }

  /// 自动起服务时用哪份仓库。build.sh 把**主仓**的路径（不是某个 worktree，worktree 验收后
  /// 就删了）写进 Info.plist；`defaults write dev.ash.mac AshRepoPath <路径>` 可以改指。
  static var repoURL: URL? {
    let raw = UserDefaults.standard.string(forKey: "AshRepoPath")
      ?? Bundle.main.object(forInfoDictionaryKey: "AshRepoPath") as? String
    guard let raw, !raw.isEmpty else { return nil }
    return URL(fileURLWithPath: raw, isDirectory: true)
  }

  /// 同源判据：scheme + host + port。127.0.0.1 与 localhost 视为同一台，免得服务端回跳
  /// 到另一种写法时被当成外链踢去浏览器。
  static func isSameOrigin(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), scheme == baseURL.scheme?.lowercased() else { return false }
    let loopback: Set<String> = ["127.0.0.1", "localhost", "::1"]
    let host = url.host?.lowercased() ?? ""
    let baseHost = baseURL.host?.lowercased() ?? ""
    let hostMatches = host == baseHost || (loopback.contains(host) && loopback.contains(baseHost))
    return hostMatches && port(of: url) == port(of: baseURL)
  }

  private static func port(of url: URL) -> Int {
    url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80)
  }
}
