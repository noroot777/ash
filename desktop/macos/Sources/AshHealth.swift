import Foundation

/// 端口上应答的是谁 —— 启动器、窗口恢复、`--start-server` 都只认这一份判据。
///
/// 「就绪」不能只看状态码：端口上随便一个回 200 的东西（代理的错误页、`ok: false` 的自检）都会被
/// 当成服务好了。也不能只看「是不是 ash」：:4317 上完全可能是仓库里的开发实例，悄悄连上去，用户
/// 以为在用 app，数据其实写进了另一份库。所以本机地址还要认**数据根**是不是本 app 那一个
/// （`/api/health` 对本机直连会报 `instance.dataDir`）。
enum AshProbe {
  /// 连不上（没人听这个端口）。
  case down
  /// 有东西应答，但不是 ash。
  case notAsh(String)
  case ash(AshInstance)
}

struct AshInstance {
  let pid: Int?
  /// 旧版本的 ash 不报这两项。
  let dataDir: String?
  let codeDir: String?

  /// 是不是本 app 管的那份：数据根是同一个目录。
  var isOurs: Bool {
    guard let dataDir else { return false }
    return AshHealth.samePath(dataDir, AshConfig.dataURL.path)
  }
}

enum AshHealth {
  static func classify(response: URLResponse?, data: Data?) -> AshProbe {
    guard let http = response as? HTTPURLResponse else { return .down }
    guard http.statusCode == 200, let data,
          let health = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          health["ok"] as? Bool == true else {
      return .notAsh("HTTP \(http.statusCode)")
    }
    let instance = health["instance"] as? [String: Any]
    return .ash(AshInstance(
      pid: health["pid"] as? Int,
      dataDir: instance?["dataDir"] as? String,
      codeDir: instance?["codeDir"] as? String))
  }

  /// 窗口能不能把页面载进来：本机地址必须是自己那份；连别处的 ash 时只要它是 ash。
  static func isServing(_ probe: AshProbe) -> Bool {
    guard case .ash(let instance) = probe else { return false }
    return !AshConfig.isLocal || instance.isOurs
  }

  /// 探一次。回调在 URLSession 的后台队列上。
  static func probe(completion: @escaping (AshProbe) -> Void) {
    var request = URLRequest(url: AshConfig.healthURL, timeoutInterval: 1.5)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    URLSession.shared.dataTask(with: request) { data, response, _ in
      completion(classify(response: response, data: data))
    }.resume()
  }

  /// 同步探一次。只在后台队列上调。
  static func probeSync() -> AshProbe {
    let done = DispatchSemaphore(value: 0)
    var result = AshProbe.down
    probe { result = $0; done.signal() }
    done.wait()
    return result
  }

  /// 两个路径是不是同一处：都按 realpath 比（/tmp 与 /private/tmp、末尾的斜杠、软链）。
  static func samePath(_ a: String, _ b: String) -> Bool {
    canonical(a) == canonical(b)
  }

  private static func canonical(_ path: String) -> String {
    if let resolved = realpath(path, nil) {
      defer { free(resolved) }
      return String(cString: resolved)
    }
    return URL(fileURLWithPath: path).standardizedFileURL.path
  }
}
