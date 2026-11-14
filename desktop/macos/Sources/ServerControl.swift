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

/// 评估时端口上是谁。放行之后只停评估过的那一份（ServerShutdown.stop）：中间换了人就重新评估，
/// 不拿上一次的结论去停另一份服务。
enum ServiceTarget: Equatable {
  /// 确认没人在听（连接被拒）。
  case absent
  /// 确认是别的 ash：它报了自己的数据根，不是这一份，用的不是这份库。
  case foreign(pid: Int?)
  /// 连的是别处的 ash（不是本机地址）：app 不管它的死活，换 app 也不重启它。
  case remote
  /// 自己那份，进程号是这个。
  case ours(pid: Int)
}

/// 让自己那份服务下线，给换代码让路。只停**评估过的那一份**（UpdateGate 问 restart-impact 时
/// 端口上的那个进程）：这会儿端口上换了人、或者认不出是谁，一律不停、回去重新评估 —— 不拿上一次
/// 「不会打断谁」的结论去停另一份服务。别的 ash 用的不是这份库，跟这次更新无关，不碰。
///
/// SIGTERM 就够了：在跑的单飞 agent 输出走文件，不随 server 死，新 server 起来按 pid 接管；团队
/// 调度台下次有人说话时 --resume 接回（server 的 reattach.ts）。会被真正打断的那些在这之前已经
/// 由 UpdateGate 问过用户。
enum ServerShutdown {
  enum Result: Equatable {
    /// 停了（或者确认本来就没在跑 / 端口上不是自己那份）。带上停掉的 pid。
    case stopped(Int?)
    /// 端口上已经不是评估过的那一份了（或者这会儿认不出来）：没停任何东西，该重新评估。
    case changed(String)
    case failed(String)
  }

  /// `target` 为 nil：用户在「确认不了」时点了「现在」—— 停那时候端口上自己那份，认不出是谁就不停。
  static func stop(expecting target: ServiceTarget?, timeout: TimeInterval = 20) -> Result {
    if target == .remote { return .stopped(nil) }
    switch AshHealth.probeSync() {
    case .down:
      // 没人在听了。评估过的那个进程要是还在（正在自己退出），等它退干净。
      guard case .ours(let pid) = target else { return .stopped(nil) }
      return waitGone(pid, timeout: timeout)
    case .unreachable(let why):
      return .changed("服务这会儿没有答复（\(why)）")
    case .notAsh(let what):
      return .changed("端口上的应答不像 ash（\(what)）")
    case .ash(let instance) where !instance.isOurs:
      guard instance.dataDir != nil else { return .changed("端口上的 ash 认不出是不是这一份") }
      if case .ours = target { return .changed("端口上换成了别的 ash") }
      return .stopped(nil)
    case .ash(let instance):
      guard let pid = instance.pid, pid > 1 else { return .failed("服务没报自己的进程号，没法让它下线。") }
      if let target, target != .ours(pid: pid) { return .changed("服务换了一份（进程 \(pid)）") }
      guard let pid32 = Int32(exactly: pid) else { return .failed("服务的进程号不对：\(pid)") }
      if kill(pid32, SIGTERM) != 0 && errno != ESRCH {
        return .failed("停不了服务进程 \(pid)：\(String(cString: strerror(errno)))")
      }
      return waitGone(pid, timeout: timeout)
    }
  }

  private static func waitGone(_ pid: Int, timeout: TimeInterval) -> Result {
    guard let pid32 = Int32(exactly: pid) else { return .failed("服务的进程号不对：\(pid)") }
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      let gone = kill(pid32, 0) != 0 && errno == ESRCH
      if gone, case .down = AshHealth.probeSync() { return .stopped(pid) }
      Thread.sleep(forTimeInterval: 0.2)
    }
    return .failed("服务进程 \(pid) \(Int(timeout)) 秒内没有退出，更新没装。看日志 \(AshConfig.serverLogURL.path)。")
  }
}

/// 维护期：UpdateGate 从停服务、备份库到 Sparkle 换完 app 这段时间，任何入口都不许起服务 ——
/// 这个窗口、登录项的 `--start-server`、另开的一份 app 都一样，否则旧代码会再起一份，迁移前的
/// 备份就白做了。所以它记在数据根里，不只在本进程内存里。两样一起用：
///  · 启动锁（.mac-launch.lock）由维护方一直攥着：正在起服务的那一处做完之前维护方拿不到它、
///    也就不会去停服务；维护方攥着时，起服务的那一处在拿锁之前就先看到下面的标记、直接不起。
///  · 标记文件说明「为什么不起」。持有它的进程活着才算数：进程没了（装完被 Sparkle 退掉了、崩了）
///    标记就作废，别处照常起。本进程自己的标记永远算数；别的进程的超过一刻钟也作废（防进程号复用）。
final class Maintenance {
  private struct Marker: Codable {
    let pid: Int32
    let note: String
    let since: Date
  }

  static let fileName = ".mac-maintenance.json"
  static var url: URL { AshConfig.dataURL.appendingPathComponent(fileName) }
  private static let staleAfter: TimeInterval = 15 * 60

  private var lock: ServerStartLock?

  private init(lock: ServerStartLock) { self.lock = lock }

  /// 攥住启动锁、写标记。另一处正在起服务时等它做完，等满 timeout 秒还拿不到就报错。
  static func begin(note: String, timeout: TimeInterval) throws -> Maintenance {
    let lock = try ServerStartLock(dataDir: AshConfig.dataURL)
    let deadline = Date().addingTimeInterval(timeout)
    while try !lock.tryAcquire() {
      guard Date() < deadline else { throw SQLiteFile.Failure("另一处正在起 ash 服务，\(Int(timeout)) 秒还没完") }
      Thread.sleep(forTimeInterval: 0.2)
    }
    let marker = Marker(pid: getpid(), note: note, since: Date())
    try JSONEncoder().encode(marker).write(to: url, options: .atomic)
    return Maintenance(lock: lock)
  }

  /// 收回标记、松开启动锁。可以重复调。
  func end() {
    guard lock != nil else { return }
    if let marker = Self.readMarker(), marker.pid == getpid() { try? FileManager.default.removeItem(at: Self.url) }
    lock = nil  // 关掉描述符，flock 随之松开
  }

  /// 有维护在进行就返回那句说给用户听的话。作废的标记顺手删掉。
  static func activeNote() -> String? {
    guard let marker = readMarker() else { return nil }
    if marker.pid == getpid() { return marker.note }
    let alive = kill(marker.pid, 0) == 0 || errno == EPERM
    if alive && Date().timeIntervalSince(marker.since) < staleAfter { return marker.note }
    try? FileManager.default.removeItem(at: url)
    return nil
  }

  private static func readMarker() -> Marker? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(Marker.self, from: data)
  }
}
