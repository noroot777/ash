import Foundation
import SQLite3

/// 拷 SQLite 库只走在线备份：库可能正被 server 开着（WAL 模式、随时在写），按文件拷到一半的
/// `ash.db` 加上对不上的 `-wal` 就是一份坏库。在线备份在一个读事务里整份拷出，是某一时刻的
/// 一致快照，WAL 里还没落进主文件的写入也带上；写库的进程不受影响。导入旧数据和更新前备份共用。
enum SQLiteFile {
  struct Failure: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
  }

  static func open(_ url: URL, flags: Int32) throws -> OpaquePointer {
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

  /// 把 `source` 一致地拷成 `target`（target 不存在或可以覆盖），拷完跑一遍 quick_check。
  /// 拷出来的是单独一个文件，旁边不带 -wal / -shm。
  static func snapshot(from source: URL, to target: URL) throws {
    try copy(from: source, to: target)
    // 离开 WAL 模式后 SQLite 会把那个已经没用的 -shm 留在原地；库已经关了，删掉。
    for suffix in ["-shm", "-wal"] { try? FileManager.default.removeItem(atPath: target.path + suffix) }
  }

  private static func copy(from source: URL, to target: URL) throws {
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
    // 在线备份连源库的 WAL 模式一起抄过来：拷出来的那份关掉时会在旁边留 -wal / -shm，改名之后
    // 它们就跟主文件对不上了。切回回滚日志模式，拷出来的就是一个自成一体的文件（server 打开时
    // 会自己再切成 WAL）。
    guard sqlite3_exec(to, "pragma journal_mode = delete", nil, nil, nil) == SQLITE_OK else {
      throw Failure("备份库失败：\(String(cString: sqlite3_errmsg(to)))")
    }
    var statement: OpaquePointer?
    defer { sqlite3_finalize(statement) }
    guard sqlite3_prepare_v2(to, "pragma quick_check", -1, &statement, nil) == SQLITE_OK,
          sqlite3_step(statement) == SQLITE_ROW, let text = sqlite3_column_text(statement, 0),
          String(cString: text) == "ok" else {
      throw Failure("拷出来的库没通过完整性检查。")
    }
  }
}

/// 装新版之前给库留一份底：新版 server 一启动就做迁移，迁移不可逆，新版起不来时只有这份备份
/// 配上旧版 app 能回去（步骤见 README「回到旧版」）。
///
/// 放在 `<数据根>/backups/`，文件名 `<时间>-<旧构建号>.db`：时间在前，按名字排就是按时间排；
/// 旧构建号说明该配哪一版 app。先写 `.partial` 再改名，中途失败不会留下一份看着完整的半截库；
/// 同名的已经在就另起一个名字，绝不覆盖。
///
/// **恢复点**：迁移前的那一份原件被固定下来（`recovery-point.json` 记着是哪个文件），直到新版的
/// 服务真起来了（迁移跑完了，ServerLauncher 确认就绪时 `release`）才放开。固定着的时候：
///  · 它不参与「只留最近几份」的轮换；
///  · 起服务前不再补备份（ServerLauncher 据此认出原件已经留过了）—— 新版连着起不来时，每次重试
///    抓到的都是被失败的迁移改过一半的库，要是照常备份、照常轮换，原件很快就被挤掉；
///  · 再来一次更新前备份照做，但恢复点仍是最早那份原件。
/// 恢复点写不进去就算备份失败：没有它就没人记得哪一份才是原件。
enum DatabaseBackup {
  static let keep = 5
  private static var pinURL: URL { AshConfig.backupURL.appendingPathComponent("recovery-point.json") }

  private struct Pin: Codable {
    let file: String
    let fromVersion: String
    let since: Date
  }

  /// 备份当前数据根里的库，还没有恢复点就把这一份定为恢复点。数据根里还没有库（从没起过服务）
  /// 就什么都不做，返回 nil。
  @discardableResult
  static func beforeUpdate(fromVersion: String, now: Date = Date()) throws -> URL? {
    let db = AshConfig.dataURL.appendingPathComponent("ash.db")
    guard FileManager.default.fileExists(atPath: db.path) else { return nil }
    let dir = AshConfig.backupURL
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let stamp = DateFormatter()
    stamp.locale = Locale(identifier: "en_US_POSIX")
    stamp.timeZone = TimeZone(identifier: "UTC")
    stamp.dateFormat = "yyyyMMdd-HHmmss"
    let base = "\(stamp.string(from: now))-\(fromVersion.replacingOccurrences(of: "/", with: "_"))"
    var target = dir.appendingPathComponent("\(base).db")
    var attempt = 1
    while FileManager.default.fileExists(atPath: target.path) {
      attempt += 1
      target = dir.appendingPathComponent("\(base)-\(attempt).db")
    }
    let partial = target.appendingPathExtension("partial")
    try? FileManager.default.removeItem(at: partial)
    do {
      try SQLiteFile.snapshot(from: db, to: partial)
      try FileManager.default.moveItem(at: partial, to: target)
    } catch {
      try? FileManager.default.removeItem(at: partial)
      throw error
    }
    if recoveryPoint() == nil {
      let pin = Pin(file: target.lastPathComponent, fromVersion: fromVersion, since: now)
      try JSONEncoder().encode(pin).write(to: pinURL, options: .atomic)
    }
    prune(dir)
    return target
  }

  /// 固定着的迁移前原件（新版还没确认起来过）。记录指向的文件不在了就当没有。
  static func recoveryPoint() -> URL? {
    guard let data = try? Data(contentsOf: pinURL), let pin = try? JSONDecoder().decode(Pin.self, from: data) else { return nil }
    let url = AshConfig.backupURL.appendingPathComponent(pin.file)
    return FileManager.default.fileExists(atPath: url.path) ? url : nil
  }

  /// 新版的服务起来了（迁移跑完了）：恢复点回到普通轮换里。
  static func releaseRecoveryPoint() {
    try? FileManager.default.removeItem(at: pinURL)
  }

  /// 最近的几份备份，新的在前。
  static func existing() -> [URL] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: AshConfig.backupURL.path)) ?? []
    return names.filter { $0.hasSuffix(".db") }.sorted(by: >).map { AshConfig.backupURL.appendingPathComponent($0) }
  }

  private static func prune(_ dir: URL) {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
    for name in names where name.hasSuffix(".partial") {
      try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
    }
    let pinned = recoveryPoint()
    for old in existing().dropFirst(keep) where old != pinned { try? FileManager.default.removeItem(at: old) }
  }
}
