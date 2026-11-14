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

  /// 只读打开 WAL 模式的库要 -shm 在（或者能建）；源实例正常停掉之后 -wal、-shm 都收掉了，只读那一下
  /// 就打不开。那时主文件已经是完整的一份，按 immutable 读（不建 -shm、不碰源目录）。
  static func open(_ url: URL, flags: Int32) throws -> OpaquePointer {
    do {
      return try openOnce(url.path, flags: flags)
    } catch where flags & SQLITE_OPEN_READONLY != 0
      && !FileManager.default.fileExists(atPath: url.path + "-wal") && FileManager.default.fileExists(atPath: url.path) {
      var components = URLComponents()
      components.scheme = "file"
      components.path = url.path
      components.queryItems = [URLQueryItem(name: "immutable", value: "1")]
      return try openOnce(components.string ?? url.path, flags: flags | SQLITE_OPEN_URI, shown: url.path)
    }
  }

  private static func openOnce(_ name: String, flags: Int32, shown: String? = nil) throws -> OpaquePointer {
    var handle: OpaquePointer?
    let rc = sqlite3_open_v2(name, &handle, flags, nil)
    guard rc == SQLITE_OK, let handle else {
      let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "错误码 \(rc)"
      sqlite3_close(handle)
      throw Failure("打不开 \(shown ?? name)：\(message)")
    }
    sqlite3_busy_timeout(handle, 5000)
    // 打开是惰性的：WAL 库只读打不开要到第一次读才报出来，这里当场读一下。
    var statement: OpaquePointer?
    let read = sqlite3_prepare_v2(handle, "pragma schema_version", -1, &statement, nil) == SQLITE_OK
      && sqlite3_step(statement) == SQLITE_ROW
    sqlite3_finalize(statement)
    guard read else {
      let message = String(cString: sqlite3_errmsg(handle))
      sqlite3_close(handle)
      throw Failure("读不出 \(shown ?? name)：\(message)")
    }
    return handle
  }

  static func scalar(_ handle: OpaquePointer, _ sql: String) -> String? {
    var statement: OpaquePointer?
    defer { sqlite3_finalize(statement) }
    guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, sqlite3_step(statement) == SQLITE_ROW,
          let text = sqlite3_column_text(statement, 0) else { return nil }
    return String(cString: text)
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
    guard scalar(to, "pragma quick_check") == "ok" else {
      throw Failure("拷出来的库没通过完整性检查。")
    }
  }
}

/// 装新版之前给库留一份底：新版 server 一启动就做迁移，迁移不可逆，新版起不来时只有这份备份
/// 配上旧版 app 能回去（步骤见 README「回到旧版」）。
///
/// 放在 `<数据根>/backups/`，文件名 `<时间>-<旧构建号>.db`，旧构建号说明该配哪一版 app。先写
/// `.partial` 再改名，中途失败不会留下一份看着完整的半截库；同名的已经在就另起一个名字，绝不
/// 覆盖。「新的在前」按文件生成的先后排，不按名字。
///
/// **恢复点**：每一份更新前备份都先固定着（`recovery-points.json`），直到确认**之后有一份服务在
/// 这份库上真起来过**（ServerRecord.confirmServing：端口上应答的就是记录里那个进程 —— 不管是谁
/// 等到的、隔了多久才看到）。确认之前：
///  · 它们不参与「只留最近几份」的轮换；
///  · 起服务前按它们判断这一次是不是已经备过了（`covers`）。只认「留它的时候，库最后一次是交给
///    哪一版起的」和现在一样的那份 —— 之后又有别的版本起过（哪怕没人看到它起来），那份就不是
///    这一次的底了，照常再备一份。
/// 确认之后它们作废：记录里留着确认时间，比它早的一律不算，删不掉那个文件也不会被误当成这一次
/// 的底。恢复点写不进去就算备份失败：没有它就没人记得哪一份才是原件。
enum DatabaseBackup {
  static let keep = 5
  private static var pinsURL: URL { AshConfig.backupURL.appendingPathComponent("recovery-points.json") }

  private struct Pin: Codable {
    let file: String
    /// 留它的时候库最后一次交给哪一版起（ServerRecord 的构建号；没有记录是 "unknown"）。
    let lastServedBy: String
    let since: Date
  }

  /// 备份当前数据根里的库，固定成恢复点。`fromVersion` 只用来起文件名。数据根里还没有库（从没
  /// 起过服务）就什么都不做，返回 nil。
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
    let pin = Pin(file: target.lastPathComponent, lastServedBy: ServerRecord.read()?.bundleVersion ?? "unknown", since: Date())
    try JSONEncoder().encode(validPins() + [pin]).write(to: pinsURL, options: .atomic)
    prune(dir)
    return target
  }

  /// 还固定着的恢复点（之后没有服务确认起来过），新的在前。第一个就是离现在最近的那次更新前的底。
  static func recoveryPoints() -> [URL] {
    validPins().reversed().map { AshConfig.backupURL.appendingPathComponent($0.file) }
  }

  /// 这一次（库最后交给 `lastServedBy` 那一版起）是不是已经备过了。
  static func covers(lastServedBy version: String) -> Bool {
    validPins().contains { $0.lastServedBy == version }
  }

  /// 有一份服务在这份库上真起来了（迁移跑完了）：恢复点回到普通轮换里。删不掉也不要紧 ——
  /// 比确认时间早的恢复点本来就不算（见 `validPins`）。
  static func releaseRecoveryPoints() {
    try? FileManager.default.removeItem(at: pinsURL)
  }

  private static func validPins() -> [Pin] {
    guard let data = try? Data(contentsOf: pinsURL), let pins = try? JSONDecoder().decode([Pin].self, from: data) else { return [] }
    let confirmed = ServerRecord.read()?.confirmedAt ?? .distantPast
    return pins.filter {
      $0.since > confirmed && FileManager.default.fileExists(atPath: AshConfig.backupURL.appendingPathComponent($0.file).path)
    }
  }

  /// 全部备份，新的在前（按生成先后；同一秒的几份名字排不出先后）。
  static func existing() -> [URL] {
    let dir = AshConfig.backupURL
    let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
    let made = { (url: URL) -> Date in (try? url.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast }
    return names.filter { $0.hasSuffix(".db") }.map { dir.appendingPathComponent($0) }
      .map { ($0, made($0)) }
      .sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.lastPathComponent > $1.0.lastPathComponent }
      .map(\.0)
  }

  private static func prune(_ dir: URL) {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
    for name in names where name.hasSuffix(".partial") {
      try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
    }
    let pinned = Set(recoveryPoints())
    for old in existing().dropFirst(keep) where !pinned.contains(old) { try? FileManager.default.removeItem(at: old) }
  }
}
