import Foundation

/// 「现在重启服务会打断谁」—— 问的是 server 的 `/api/restart-impact`，与 `npm run restart` 的安全闸
/// 同一条口径（判据和分类的依据都在 server/src/reattach.ts）。换 app 就是重启它里面的服务，所以
/// 装更新前问的也是它。
///
/// 算「会打断」的两类：
///  · interrupted   重启后接不回来、会被判 failed 的（排队中还没进程的、进程已经不在的……）
///  · mcpDisrupted  进程活得过重启，但手里握着 ash MCP：服务换代码那几十秒里它的交卷撞上就失败，
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

  /// 同一个任务两类都占时只算一次（interrupted 优先：它说的后果更重）。
  var disrupted: [(title: String, why: String)] {
    var seen = Set<String>()
    var out: [(title: String, why: String)] = []
    for item in interrupted where seen.insert(item.id).inserted {
      out.append((item.title, item.reason.map { "会被判失败：\($0)" } ?? "会被判失败"))
    }
    for item in mcpDisrupted where seen.insert(item.id).inserted {
      out.append((item.title, "手里握着 ash MCP，服务重启那会儿交卷可能失败"))
    }
    return out
  }
}

/// 问一次的结果。
enum ImpactVerdict {
  /// 确认不会打断任何任务：自己那份没在跑、端口上是别的 ash，或者问到了、是空的。
  case clear(ServiceTarget)
  case disrupts(ServiceTarget, [(title: String, why: String)])
  /// 确认不了：服务没答复、答的不像 ash、没报身份，或者 restart-impact 问不出来（拒答、超时、
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
  static func assessSync() -> ImpactVerdict {
    guard AshConfig.isLocal else { return .clear(.remote) }
    switch AshHealth.probeSync() {
    case .down:
      return .clear(.absent)
    case .unreachable(let why):
      return .unknown("服务没有答复：\(why)")
    case .notAsh(let what):
      // 自己那份正忙、正在重启时也会这样（比如一次 503），不能当成「端口上不是 ash」。
      return .unknown("端口上的应答不像 ash（\(what)）")
    case .ash(let instance) where !instance.isOurs:
      guard instance.dataDir != nil else { return .unknown("端口上的 ash 没报数据根在哪，认不出是不是这一份") }
      return .clear(.foreign(pid: instance.pid))
    case .ash(let instance):
      guard let pid = instance.pid, pid > 1 else { return .unknown("服务没报自己的进程号") }
      return askImpact(of: .ours(pid: pid))
    }
  }

  private static func askImpact(of target: ServiceTarget) -> ImpactVerdict {
    var request = URLRequest(url: AshConfig.baseURL.appendingPathComponent("api/restart-impact"), timeoutInterval: 8)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    // 与 restart.mjs 同一张凭证：单实例锁里那串 token（文件 0600）。本机直连多半用不上，带着不吃亏。
    if let token = hostToken() { request.setValue(token, forHTTPHeaderField: "x-ash-host-token") }
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
      let disrupted = impact.disrupted
      verdict = disrupted.isEmpty ? .clear(target) : .disrupts(target, disrupted)
    }.resume()
    done.wait()
    return verdict
  }

  private static func hostToken() -> String? {
    let lock = AshConfig.dataURL.appendingPathComponent("ash.db.ash.lock")
    guard let data = try? Data(contentsOf: lock),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return json["token"] as? String
  }
}
