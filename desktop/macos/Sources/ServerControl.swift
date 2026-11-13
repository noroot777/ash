import Foundation
import Darwin

/// 「端口上那份服务是哪一版 app 起的」。app 起好服务后在数据根里记一笔 pid + 构建号；换了新版
/// app（Sparkle 装完重开、`build.sh --install`）再连上时，pid 还是那个、构建号却不是自己 = 服务还在
/// 跑旧版代码，而且它后面才加载的模块已经是新版的文件了 —— 两版混着跑。见 UpdateGate 的
/// `.staleServer`。
///
/// 记录里的 pid 对不上（服务是别处起的、比这版 app 旧的 app 起的）就是「不知道」，不当成旧版。
struct ServerRecord: Codable {
  static let fileName = ".mac-server.json"
  static var url: URL { AshConfig.dataURL.appendingPathComponent(fileName) }

  let pid: Int
  let bundleVersion: String

  static func write(pid: Int) {
    let record = ServerRecord(pid: pid, bundleVersion: AshConfig.bundleVersion)
    if let data = try? JSONEncoder().encode(record) { try? data.write(to: url, options: .atomic) }
  }

  static func read() -> ServerRecord? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(ServerRecord.self, from: data)
  }

  /// 正在应答的这份（pid）是不是由别的构建号的 app 起的；是就返回那个构建号。
  static func staleVersion(servingPID pid: Int?) -> String? {
    guard let pid, let record = read(), record.pid == pid, record.bundleVersion != AshConfig.bundleVersion else { return nil }
    return record.bundleVersion
  }
}

/// 让自己那份服务下线，给换代码让路。只停**自己那份**（按数据根认，见 AshInstance.isOurs）：
/// 端口上要是别的 ash，它用的不是这份库，跟这次更新无关。
///
/// SIGTERM 就够了：在跑的单飞 agent 输出走文件，不随 server 死，新 server 起来按 pid 接管；团队
/// 调度台下次有人说话时 --resume 接回（server 的 reattach.ts）。会被真正打断的那些在这之前已经
/// 由 UpdateGate 问过用户。
enum ServerShutdown {
  enum Result: Equatable {
    /// 停了（或者本来就没在跑 / 端口上不是自己那份）。带上停掉的 pid。
    case stopped(Int?)
    case failed(String)
  }

  static func stopOurs(timeout: TimeInterval = 20) -> Result {
    guard case .ash(let instance) = AshHealth.probeSync(), instance.isOurs else { return .stopped(nil) }
    guard let pid = instance.pid, pid > 1, let pid32 = Int32(exactly: pid) else {
      return .failed("服务没报自己的进程号，没法让它下线。")
    }
    if kill(pid32, SIGTERM) != 0 && errno != ESRCH {
      return .failed("停不了服务进程 \(pid)：\(String(cString: strerror(errno)))")
    }
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      let gone = kill(pid32, 0) != 0 && errno == ESRCH
      if gone, case .down = AshHealth.probeSync() { return .stopped(pid) }
      Thread.sleep(forTimeInterval: 0.2)
    }
    return .failed("服务进程 \(pid) \(Int(timeout)) 秒内没有退出，更新没装。看日志 \(AshConfig.serverLogURL.path)。")
  }
}
