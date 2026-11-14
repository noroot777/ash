import Foundation

/// 端口上应答的是谁 —— 启动器、窗口恢复、`--start-server` 都只认这一份判据。
///
/// 「就绪」不能只看状态码：端口上随便一个回 200 的东西（代理的错误页、`ok: false` 的自检）都会被
/// 当成服务好了。也不能只看「是不是 ash」：:4317 上完全可能是仓库里的开发实例，悄悄连上去，用户
/// 以为在用 app，数据其实写进了另一份库。所以本机地址还要认它是不是本 app 起的那一份
/// （`/api/health` 对本机直连会报 `instance`）：数据根是 app 的、代码是 app 自带的、开着本机自用
/// 模式，三样都对上才算。只看数据根不够 —— 仓库里的开发实例完全可以指着 app 的数据根起。
///
/// 认人只能回答「刚才那一刻是谁」。认过之后页面、原生发的请求还得带上那一份的实例号（`id`），
/// 端口换了人，新来的那份见到别人的实例号就不执行（server/src/instance-binding.ts）。
enum AshProbe {
  /// 连不上：连接被拒，没人听这个端口。
  case down
  /// 请求发出去了却没等到答复（超时、连接半路断了……）：可能没人，也可能有人在、只是这会儿答不上来。
  /// 起服务的那几处跟 `.down` 一样对待；装更新那道闸把它当成「确认不了」（见 RestartImpactProbe）。
  case unreachable(String)
  /// 有东西应答，但不是 ash。
  case notAsh(String)
  case ash(AshInstance)
}

struct AshInstance {
  let pid: Int?
  /// 这个服务进程的实例号，每次起服务都换。旧版本的 ash 不报这四项。
  let id: String?
  let dataDir: String?
  let codeDir: String?
  let localOnly: Bool?
  /// 它给 app 窗口监听的专用端口（server/src/window-port.ts），没监听上是 nil。
  let windowPort: Int?

  /// 是不是本 app 管的那份。
  var isOurs: Bool { mismatch == nil }

  /// 哪一样对不上（说给用户听），全对上是 nil。
  var mismatch: String? {
    guard let id, !id.isEmpty, let dataDir, let codeDir, let localOnly else {
      return "它没报自己的实例号和代码、数据在哪（比这个 app 旧的版本），认不出来历。"
    }
    guard AshHealth.samePath(dataDir, AshConfig.dataURL.path) else { return "它用的是另一份数据。" }
    guard AshHealth.samePath(codeDir, AshConfig.runtimeURL.path) else { return "它用的是 app 的数据，跑的却不是 app 自带的代码。" }
    guard localOnly else { return "它跑的是 app 自带的代码，但没开本机自用模式（不是 app 起的）。" }
    guard windowPort == AshConfig.windowPort else {
      return "它没在 app 窗口的专用端口 \(AshConfig.windowPort) 上监听（那个端口多半被别的程序占着，或者它不是这个版本的 app 起的）。"
    }
    return nil
  }
}

enum AshHealth {
  static func classify(response: URLResponse?, data: Data?, error: Error? = nil) -> AshProbe {
    guard let http = response as? HTTPURLResponse else {
      if let error = error as? URLError, error.code == .cannotConnectToHost { return .down }
      return .unreachable(error?.localizedDescription ?? "没有答复")
    }
    guard http.statusCode == 200, let data,
          let health = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          health["ok"] as? Bool == true else {
      return .notAsh("HTTP \(http.statusCode)")
    }
    let instance = health["instance"] as? [String: Any]
    return .ash(AshInstance(
      pid: health["pid"] as? Int,
      id: instance?["id"] as? String,
      dataDir: instance?["dataDir"] as? String,
      codeDir: instance?["codeDir"] as? String,
      localOnly: instance?["localOnly"] as? Bool,
      windowPort: instance?["windowPort"] as? Int))
  }

  /// 窗口能不能把页面载进来：本机地址必须是自己那份；连别处的 ash 时只要它是 ash。
  static func isServing(_ probe: AshProbe) -> Bool {
    guard case .ash(let instance) = probe else { return false }
    return !AshConfig.isLocal || instance.isOurs
  }

  /// 本机地址上认过的自己那一份；连别处的 ash、或者不是自己那份时是 nil。
  static func ours(_ probe: AshProbe) -> AshInstance? {
    guard AshConfig.isLocal, case .ash(let instance) = probe, instance.isOurs else { return nil }
    return instance
  }

  /// 探一次。回调在 URLSession 的后台队列上。
  /// `url` 缺省问 4317 那一边（启动器认端口上是谁）；窗口认人问的是它自己连着的专用端口。
  static func probe(_ url: URL = AshConfig.healthURL, completion: @escaping (AshProbe) -> Void) {
    var request = URLRequest(url: url, timeoutInterval: 1.5)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    URLSession.shared.dataTask(with: request) { data, response, error in
      completion(classify(response: response, data: data, error: error))
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
    realPath(a) == realPath(b)
  }

  /// 还不存在的路径按最近一层存在的父目录解析再接上剩下的（数据根可能还没建）。
  static func realPath(_ path: String) -> String {
    let url = URL(fileURLWithPath: path).standardizedFileURL
    if let resolved = realpath(url.path, nil) {
      defer { free(resolved) }
      return String(cString: resolved)
    }
    let parent = url.deletingLastPathComponent()
    guard parent.path != url.path else { return url.path }
    return URL(fileURLWithPath: realPath(parent.path)).appendingPathComponent(url.lastPathComponent).path
  }
}
