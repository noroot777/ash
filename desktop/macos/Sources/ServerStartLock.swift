import Foundation
import Darwin

/// 同一个数据根同一时刻只许一处在「起服务」：打开 app 的窗口和登录时的 `--start-server`
/// 可能同时发现服务不在。锁文件放在数据根里（与 server 自己的单实例锁同一处），跟着数据走：
/// 临时数据根的验证实例与日常那份互不相扰。flock 随进程退出自动释放，不留死锁。
final class ServerStartLock {
  let descriptor: Int32

  static func url(dataDir: URL) -> URL { dataDir.appendingPathComponent(".mac-launch.lock") }

  init(dataDir: URL) throws {
    try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
    descriptor = open(Self.url(dataDir: dataDir).path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
  }

  func tryAcquire() throws -> Bool {
    if flock(descriptor, LOCK_EX | LOCK_NB) == 0 { return true }
    if errno == EWOULDBLOCK { return false }
    throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
  }

  deinit { close(descriptor) }
}
