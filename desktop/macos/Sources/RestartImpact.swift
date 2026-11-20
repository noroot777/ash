import Foundation

/// 「现在重启服务会打断谁」—— 问的是 server 的 `/api/restart-impact`，与 `npm run restart` 的安全闸
/// 同一条口径（判据和分类的依据都在 server/src/reattach.ts）。换 app 就是重启它里面的服务，所以
/// 装更新前问的也是它。
///
/// 算「会打断」的两类：
///  · interrupted   重启后接不回来、会被判 failed 的（排队中还没进程的、进程已经不在的……）
///  · mcpDisrupted  进程活得过重启，但手里握着 navi MCP：服务换代码那几十秒里它的交卷撞上就失败，
///                  restart.mjs 对它们的默认也是「不动」
/// survives（会被接管）和 resumes（调度台自动接回）不算。
struct RestartImpact: Decodable {
  struct Item: Decodable {
    let id: String
    let title: String
    let reason: String?
  }

  let survives: [Item]
  let resumes: [Item]
  let interrupted: [Item]
  let mcpDisrupted: [Item]
  struct Handover: Decodable {
    struct Target: Decodable { let `protocol`: Int; let schema: String }
    let blocked: [Item]
    let sessions: [String]
    let target: Target?
  }
  let runtimeHandover: Handover?

  /// 同一个任务两类都占时只算一次（interrupted 优先：它说的后果更重）。
  var disrupted: [(title: String, why: String)] {
    var seen = Set<String>()
    var out: [(title: String, why: String)] = []
    for item in interrupted where seen.insert(item.id).inserted {
      out.append((item.title, item.reason.map { "会被判失败：\($0)" } ?? "会被判失败"))
    }
    for item in mcpDisrupted where seen.insert(item.id).inserted {
      out.append((item.title, "手里握着 Navi MCP，服务重启那会儿交卷可能失败"))
    }
    return out
  }
}

/// 问一次的结果。
enum ImpactVerdict {
  /// 确认不会打断任何任务：自己那份没在跑、端口上是别的 navi，或者问到了、是空的。
  case clear(ServiceTarget)
  case disrupts(ServiceTarget, [(title: String, why: String)])
  /// 确认不了：服务没答复、答的不像 navi、没报身份，或者 restart-impact 问不出来（拒答、超时、
  /// 答非所问）。**确认不了不等于没有**：按会打断对待，只有用户点了「现在」才往下走。
  case unknown(String)

  var needsConsent: Bool {
    if case .clear = self { return false }
    return true
  }

  /// 放行后该停的那一份；确认不了时是 nil（用户点了「现在」：停那时候端口上自己那份）。
  var target: ServiceTarget? {
    switch self {
    case .clear(let target), .disrupts(let target, _): return target
    case .unknown: return nil
    }
  }
}

enum RestartImpactProbe {
  /// 只在后台队列上调。
  static func assessSync(preservingRuntime: Bool = false) -> ImpactVerdict {
    guard NaviConfig.isLocal else { return .clear(.remote) }
    switch NaviHealth.probeSync() {
    case .down:
      return .clear(.absent)
    case .unreachable(let why):
      return .unknown("服务没有答复：\(why)")
    case .notNavi(let what):
      // 自己那份正忙、正在重启时也会这样（比如一次 503），不能当成「端口上不是 navi」。
      return .unknown("端口上的应答不像 Navi（\(what)）")
    case .navi(let instance) where !instance.isOurs:
      guard instance.dataDir != nil else { return .unknown("端口上的 Navi 没报数据根在哪，认不出是不是这一份") }
      return .clear(.foreign(pid: instance.pid))
    case .navi(let instance):
      guard let pid = instance.pid, pid > 1 else { return .unknown("服务没报自己的进程号") }
      return askImpact(of: .ours(pid: pid), instance: instance.id, preservingRuntime: preservingRuntime)
    }
  }

  /// 带着认过的那一份的实例号问：问到之前端口换了人，新来的那份不答（server/src/instance-binding.ts），
  /// 闸拿不到别人的名单。
  private static func askImpact(of target: ServiceTarget, instance: String?, preservingRuntime: Bool) -> ImpactVerdict {
    var url = URLComponents(url: NaviConfig.baseURL.appendingPathComponent("api/restart-impact"), resolvingAgainstBaseURL: false)!
    var nextSchema: String?
    if preservingRuntime {
      guard let next = RuntimeHandover.compatibility(), next["protocol"] as? Int == 1,
            let schema = next["schema"] as? String else { return .unknown("新版接管协议无法核实") }
      nextSchema = schema
      url.queryItems = [URLQueryItem(name: "protocol", value: "1"), URLQueryItem(name: "schema", value: schema)]
    }
    var request = URLRequest(url: url.url!, timeoutInterval: 8)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    // 与 restart.mjs 同一张凭证：单实例锁里那串 token（文件 0600）。本机直连多半用不上，带着不吃亏。
    if let token = hostToken() { request.setValue(token, forHTTPHeaderField: "x-ash-host-token") }
    if let instance { request.setValue(instance, forHTTPHeaderField: "x-ash-instance") }
    let done = DispatchSemaphore(value: 0)
    var verdict = ImpactVerdict.unknown("没有答复")
    URLSession.shared.dataTask(with: request) { data, response, error in
      defer { done.signal() }
      if let error { verdict = .unknown(error.localizedDescription); return }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard status == 200, let data else { verdict = .unknown("服务端回 \(status)"); return }
      guard let impact = try? JSONDecoder().decode(RestartImpact.self, from: data) else {
        verdict = .unknown("答复看不懂（服务端版本太旧？）")
        return
      }
      if let nextSchema, impact.runtimeHandover?.target?.protocol != 1 || impact.runtimeHandover?.target?.schema != nextSchema {
        verdict = .unknown("旧服务未核对新版兼容性，未切换服务")
        return
      }
      let disrupted = preservingRuntime
        ? (impact.runtimeHandover?.blocked.map { (title: $0.title, why: $0.reason ?? "不可接管") }
          ?? [(title: "旧服务", why: "没有可验证的安全接管能力")])
        : impact.disrupted
      verdict = disrupted.isEmpty ? .clear(target) : .disrupts(target, disrupted)
    }.resume()
    done.wait()
    return verdict
  }

  static func hostToken() -> String? {
    guard let db = try? DatabaseFile.existing(in: NaviConfig.dataURL) else { return nil }
    for lock in DatabaseFile.lockFiles(of: db) {
      if let data = try? Data(contentsOf: lock), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let token = json["token"] as? String { return token }
    }
    return nil
  }
}

enum RuntimeHandover {
  static func compatibility() -> [String: Any]? {
    guard let data = try? Data(contentsOf: NaviConfig.runtimeURL.appendingPathComponent(".handover.json")) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  static func acquire(target: ServiceTarget?) -> String? {
    guard case .ours(let pid) = target,
          case .navi(let instance) = NaviHealth.probeSync(), instance.isOurs, instance.pid == pid,
          let codeDir = instance.codeDir, RuntimeStore.contains(codeDir), let id = instance.id else { return nil }
    guard let compatibility = compatibility(),
          let result = send(instance: id, body: compatibility), let lease = result["lease"] as? String else { return nil }
    guard result["protocol"] as? Int == 1 else { _ = send(instance: id, body: ["release": lease]); return nil }
    return lease
  }

  static func release(_ lease: String) {
    guard case .navi(let instance) = NaviHealth.probeSync(), instance.isOurs, let id = instance.id else { return }
    _ = send(instance: id, body: ["release": lease])
  }

  static func isValid(_ lease: String) -> Bool {
    guard case .navi(let instance) = NaviHealth.probeSync(), instance.isOurs, let id = instance.id else { return false }
    return send(instance: id, body: ["check": lease])?["valid"] as? Bool == true
  }

  private static func send(instance: String, body: [String: Any]) -> [String: Any]? {
    guard let token = RestartImpactProbe.hostToken() else { return nil }
    var request = URLRequest(url: NaviConfig.baseURL.appendingPathComponent("api/runtime-handover"), timeoutInterval: 45)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue(token, forHTTPHeaderField: "x-navi-host-token")
    request.setValue(instance, forHTTPHeaderField: "x-navi-instance")
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    let done = DispatchSemaphore(value: 0)
    var result: [String: Any]?
    URLSession.shared.dataTask(with: request) { data, response, _ in
      if (response as? HTTPURLResponse)?.statusCode == 200, let data {
        result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      }
      done.signal()
    }.resume()
    done.wait()
    return result
  }
}
