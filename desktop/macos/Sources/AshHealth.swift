import Foundation

/// 「这台 ash 就绪了吗」的唯一判据：/api/health 回 200，且 body 是 `{"ok": true, …}`。
///
/// 启动器等服务、窗口从占位页恢复，都走这里。只认状态码的话，端口上随便一个回 200 的东西
/// （代理的错误页、`ok: false` 的自检）都会被窗口当成「服务好了」去重载，而启动器并不承认。
enum AshHealth {
  /// `expectedPID` 只在启动器确认「应答的正是我刚起的那个进程」时给；窗口恢复不关心是谁起的。
  static func isReady(response: URLResponse?, data: Data?, expectedPID: Int? = nil) -> Bool {
    guard (response as? HTTPURLResponse)?.statusCode == 200, let data,
          let health = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          health["ok"] as? Bool == true else { return false }
    return expectedPID == nil || health["pid"] as? Int == expectedPID
  }

  /// 探一次。回调在 URLSession 的后台队列上。
  static func probe(expectedPID: Int? = nil, completion: @escaping (Bool) -> Void) {
    var request = URLRequest(url: AshConfig.healthURL, timeoutInterval: 1.5)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    URLSession.shared.dataTask(with: request) { data, response, _ in
      completion(isReady(response: response, data: data, expectedPID: expectedPID))
    }.resume()
  }
}
