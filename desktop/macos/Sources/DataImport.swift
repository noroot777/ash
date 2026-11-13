import Foundation
import SQLite3
import Darwin

/// 首启时「从一份已有的 ash 数据目录导入」（比如仓库里的 `data/`）。**只复制、不移动**，源目录
/// 一个字节都不改。
///
/// 源库可能正被另一份 server 开着（WAL 模式、随时在写），所以库文件不能按文件拷：拷到一半的
/// `ash.db` 加上对不上的 `-wal` 就是一份坏库。库走 SQLite 的在线备份（一个读事务里整份拷出，
/// 是某一时刻的一致快照），其余目录（runs、uploads……）按文件复制 —— 同一个 APFS 卷上是克隆，
/// 几个 G 的 runs 也不占第二份空间。
///
/// 库最后落、而且先写到旁边再改名：中途失败或被强退时数据根里仍然没有 `ash.db`，下次打开 app
/// 还是首启那一屏，可以重来。
enum DataImport {
  struct Source {
    let url: URL
    /// 还开着这份库的 server 进程（看它的单实例锁）。nil = 没人开着。
    let livePID: Int32?
  }

  struct Failure: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
  }

  /// 看一眼这份目录能不能导：有库、不是 app 自己的数据根、不是多人模式。
  static func inspect(_ url: URL) throws -> Source {
    let db = url.appendingPathComponent("ash.db")
    guard FileManager.default.fileExists(atPath: db.path) else {
      throw Failure("\(url.path) 里没有 ash.db。要选的是 ash 的数据目录（仓库里是 data/）。")
    }
    guard !AshHealth.samePath(url.path, AshConfig.dataURL.path) else {
      throw Failure("这就是 app 自己的数据目录。")
    }
    // 多人模式的数据转不回自用（server 的 auth/mode.ts），而 app 只以本机自用模式起服务。
    if try instanceMode(of: db) == "multi" {
      throw Failure("这份数据是多人模式的。app 只以本机自用模式运行，多人数据转不回自用，没法导入。")
    }
    return Source(url: url, livePID: livePID(lock: url.appendingPathComponent("ash.db.ash.lock")))
  }

  /// 导进 `dest`（app 的数据根）。调用方保证 dest 里还没有 ash.db。
  static func run(_ source: Source, into dest: URL) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: dest, withIntermediateDirectories: true)
    for name in try fm.contentsOfDirectory(atPath: source.url.path) where !skipped(name) {
      let target = dest.appendingPathComponent(name)
      // 只可能是上一次没导完留下的：数据根里还没有库，就还没有任何一份 server 用过它。
      if fm.fileExists(atPath: target.path) || (try? fm.destinationOfSymbolicLink(atPath: target.path)) != nil {
        try fm.removeItem(at: target)
      }
      try fm.copyItem(at: source.url.appendingPathComponent(name), to: target)
    }
    let staged = dest.appendingPathComponent("ash.db.importing")
    try? fm.removeItem(at: staged)
    try backup(from: source.url.appendingPathComponent("ash.db"), to: staged)
    try fm.moveItem(at: staged, to: dest.appendingPathComponent("ash.db"))
  }

  /// 不跟着搬的：库文件本身（另走备份）和它的日志、别人的锁与在线标记、可以重建的缓存，
  /// 以及 app 自己放在数据根里的东西。
  static func skipped(_ name: String) -> Bool {
    let exact: Set<String> = ["ash.db", "ash.db-wal", "ash.db-shm", "ash.db-journal", "ash.db.importing",
                              "deps", "tmp", "logs", "downloads", ".mac-launch.lock", ".DS_Store"]
    return exact.contains(name) || name.hasSuffix(".ash.lock") || name.contains(".ash-online.")
  }

  private static func instanceMode(of db: URL) throws -> String {
    let handle = try open(db, flags: SQLITE_OPEN_READONLY)
    defer { sqlite3_close(handle) }
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(handle, "select value from app_settings where key = 'instanceMode'", -1, &statement, nil) == SQLITE_OK else {
      throw Failure("读不出这份库（\(String(cString: sqlite3_errmsg(handle)))），它可能不是 ash 的库。")
    }
    defer { sqlite3_finalize(statement) }
    guard sqlite3_step(statement) == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else { return "" }
    // 值是 JSON 编码的字符串（"\"single\""）。
    let raw = String(cString: text)
    return (try? JSONSerialization.jsonObject(with: Data(raw.utf8), options: .fragmentsAllowed) as? String) ?? raw
  }

  /// 在线备份：源库只读打开，一步拷完（一个读事务 = 一致快照），写库的进程不受影响。
  private static func backup(from source: URL, to target: URL) throws {
    let from = try open(source, flags: SQLITE_OPEN_READONLY)
    defer { sqlite3_close(from) }
    let to = try open(target, flags: SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
    defer { sqlite3_close(to) }
    guard let job = sqlite3_backup_init(to, "main", from, "main") else {
      throw Failure("备份库失败：\(String(cString: sqlite3_errmsg(to)))")
    }
    var rc: Int32
    var attempts = 0
    repeat {
      rc = sqlite3_backup_step(job, -1)
      if rc == SQLITE_BUSY || rc == SQLITE_LOCKED {
        attempts += 1
        Thread.sleep(forTimeInterval: 0.1)
      }
    } while (rc == SQLITE_OK || rc == SQLITE_BUSY || rc == SQLITE_LOCKED) && attempts < 100
    sqlite3_backup_finish(job)
    guard rc == SQLITE_DONE else { throw Failure("备份库失败（\(rc)）：\(String(cString: sqlite3_errmsg(to)))") }
    var statement: OpaquePointer?
    defer { sqlite3_finalize(statement) }
    guard sqlite3_prepare_v2(to, "pragma quick_check", -1, &statement, nil) == SQLITE_OK,
          sqlite3_step(statement) == SQLITE_ROW, let text = sqlite3_column_text(statement, 0),
          String(cString: text) == "ok" else {
      throw Failure("导出来的库没通过完整性检查，没有导入。")
    }
  }

  private static func open(_ url: URL, flags: Int32) throws -> OpaquePointer {
    var handle: OpaquePointer?
    let rc = sqlite3_open_v2(url.path, &handle, flags, nil)
    guard rc == SQLITE_OK, let handle else {
      let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "错误码 \(rc)"
      sqlite3_close(handle)
      throw Failure("打不开 \(url.path)：\(message)")
    }
    sqlite3_busy_timeout(handle, 5000)
    return handle
  }

  /// server 的单实例锁是 JSON，`pid` 那一项还活着就是有人开着这份库。
  private static func livePID(lock: URL) -> Int32? {
    guard let data = try? Data(contentsOf: lock),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let pid = json["pid"] as? Int, pid > 1, let pid32 = Int32(exactly: pid) else { return nil }
    return kill(pid32, 0) == 0 || errno == EPERM ? pid32 : nil
  }
}
