import Foundation

/// 端口上应答的是谁 —— 启动器、窗口恢复、`--start-server` 都只认这一份判据。
///
/// 「就绪」不能只看状态码：端口上随便一个回 200 的东西（代理的错误页、`ok: false` 的自检）都会被
/// 当成服务好了。也不能只看「是不是 navi」：:4317 上完全可能是仓库里的开发实例，悄悄连上去，用户
/// 以为在用 app，数据其实写进了另一份库。所以本机地址还要认它是不是本 app 起的那一份
/// （`/api/health` 对本机直连会报 `instance`）：数据根是 app 的、代码是 app 自带的、报自己是 app
/// 起的那一份（`desktop`），三样都对上才算。只看数据根不够 —— 仓库里的开发实例完全可以指着 app 的数据根起。
///
/// 认人只能回答「刚才那一刻是谁」。认过之后页面、原生发的请求还得带上那一份的实例号（`id`），
/// 端口换了人，新来的那份见到别人的实例号就不执行（server/src/instance-binding.ts）。
enum NaviProbe {
  /// 连不上：连接被拒，没人听这个端口。
  case down
  /// 请求发出去了却没等到答复（超时、连接半路断了……）：可能没人，也可能有人在、只是这会儿答不上来。
  /// 起服务的那几处跟 `.down` 一样对待；装更新那道闸把它当成「确认不了」（见 RestartImpactProbe）。
  case unreachable(String)
  /// 有东西应答，但不是 navi。
  case notNavi(String)
  case navi(NaviInstance)
}

struct NaviInstance {
  let pid: Int?
  /// 这个服务进程的实例号，每次起服务都换。旧版本的 ash 不报这四项。
  let id: String?
  let dataDir: String?
  let codeDir: String?
  let localOnly: Bool?
  /// 报自己是 app 起的那一份（server 的 `NAVI_DESKTOP_APP`）。比它旧的服务不报这一项，那时 app 只会
  /// 带着本机自用模式起它，`localOnly` 就是同一个意思。
  let desktop: Bool?
  /// 这份 Navi 跨重启不变的指纹（server/src/instance-tag.ts），navi:// 链接带着它（DeepLink）。
  let tag: String?
  /// 它给 app 窗口监听的专用端口（server/src/window-port.ts），没监听上是 nil。
  let windowPort: Int?

  /// 是不是本 app 管的那份。
  var isOurs: Bool { mismatch == nil }

  /// 哪一样对不上（说给用户听），全对上是 nil。
  var mismatch: String? {
    guard let id, !id.isEmpty, let dataDir, let codeDir, let appServed = desktop ?? localOnly else {
      return "它没报自己的实例号和代码、数据在哪（比这个 app 旧的版本），认不出来历。"
    }
    guard NaviHealth.samePath(dataDir, NaviConfig.dataURL.path) else { return "它用的是另一份数据。" }
    guard NaviHealth.samePath(codeDir, NaviConfig.runtimeURL.path) else { return "它用的是 app 的数据，跑的却不是 app 自带的代码。" }
    guard appServed else { return "它跑的是 app 自带的代码，但不是 app 起的那一份。" }
    guard windowPort == NaviConfig.windowPort else {
      return "它没在 app 窗口的专用端口 \(NaviConfig.windowPort) 上监听（那个端口多半被别的程序占着，或者它不是这个版本的 app 起的）。"
    }
    return nil
  }
}

enum NaviHealth {
  static func classify(response: URLResponse?, data: Data?, error: Error? = nil) -> NaviProbe {
    guard let http = response as? HTTPURLResponse else {
      if let error = error as? URLError, error.code == .cannotConnectToHost { return .down }
      return .unreachable(error?.localizedDescription ?? "没有答复")
    }
    guard http.statusCode == 200, let data,
          let health = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          health["ok"] as? Bool == true else {
      return .notNavi("HTTP \(http.statusCode)")
    }
    let instance = health["instance"] as? [String: Any]
    return .navi(NaviInstance(
      pid: health["pid"] as? Int,
      id: instance?["id"] as? String,
      dataDir: instance?["dataDir"] as? String,
      codeDir: instance?["codeDir"] as? String,
      localOnly: instance?["localOnly"] as? Bool,
      desktop: instance?["desktop"] as? Bool,
      tag: instance?["tag"] as? String,
      windowPort: instance?["windowPort"] as? Int))
  }

  /// 窗口能不能把页面载进来：本机地址必须是自己那份；连别处的 navi 时只要它是 navi。
  static func isServing(_ probe: NaviProbe) -> Bool {
    guard case .navi(let instance) = probe else { return false }
    return !NaviConfig.isLocal || instance.isOurs
  }

  /// 本机地址上认过的自己那一份；连别处的 navi、或者不是自己那份时是 nil。
  static func ours(_ probe: NaviProbe) -> NaviInstance? {
    guard NaviConfig.isLocal, case .navi(let instance) = probe, instance.isOurs else { return nil }
    ServedInstance.observe(instance)
    return instance
  }

  /// 探一次。回调在 URLSession 的后台队列上。
  /// `url` 缺省问 4317 那一边（启动器认端口上是谁）；窗口认人问的是它自己连着的专用端口。
  static func probe(_ url: URL = NaviConfig.healthURL, completion: @escaping (NaviProbe) -> Void) {
    var request = URLRequest(url: url, timeoutInterval: 1.5)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    URLSession.shared.dataTask(with: request) { data, response, error in
      completion(classify(response: response, data: data, error: error))
    }.resume()
  }

  /// 同步探一次。只在后台队列上调。
  static func probeSync() -> NaviProbe {
    let done = DispatchSemaphore(value: 0)
    var result = NaviProbe.down
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

/// 自己那份服务**实际**是什么样：最近一次认出它时 health 报的。菜单上那个勾是用户要的（UserDefaults），
/// 服务按起的那一下的设置定，两者可能对不上 —— 改了设置还没重启、手动改了 defaults、上一版 app 起的
/// 服务。认人（是不是自家那份）与这一层分开：对不上照样是自家服务，只是设置没生效，菜单如实写出来、
/// 点一下按设置重启（RemoteAccessSwitch）。凡是认出自家服务的地方都记一笔（`NaviHealth.ours`、
/// ServerLauncher 的 settle / waitReady），哪个线程都可以调。
enum ServedInstance {
  private static let lock = NSLock()
  private static var latest: NaviInstance?

  static func observe(_ instance: NaviInstance) {
    lock.lock()
    latest = instance
    lock.unlock()
  }

  /// 服务停了 / 换了：在看到新的那份之前不拿旧的说事。
  static func forget() {
    lock.lock()
    latest = nil
    lock.unlock()
  }

  static var current: NaviInstance? {
    lock.lock()
    defer { lock.unlock() }
    return latest
  }

  /// 在跑的服务没按菜单上的设置起：要别的设备进来、它却只听本机，或者反过来。不知道（还没认出、它没报）是 false。
  static var networkPending: Bool {
    guard let localOnly = current?.localOnly else { return false }
    return localOnly == NaviConfig.allowsOtherDevices
  }
}
