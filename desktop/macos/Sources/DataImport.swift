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
/// 一致快照不等于独立实例的快照：库里还记着源实例手上的进程和它开机要接着做的事。发布之前用自带
/// node 跑一遍 server 的 import-snapshot（洗掉进程身份、在飞的活落被打断、自动续跑停用，源数据根下
/// 的路径改到这里），否则副本开机会去接管、甚至停掉源实例正在跑的 agent。
///
/// 两段：先在数据根里一个只属于这一次的暂存目录里把整份备齐，再拿着**和起服务同一把锁**发布。
/// 锁里重查一次数据根还空着 —— 首启那一屏只是当时的一次判断，另一个窗口或登录项可能已经点了
/// 「全新开始」。发布时库最后落，它就是提交点：之前的任何一步失败，数据根里都还没有 `ash.db`，
/// 下次打开还是首启那一屏；挪了一半的条目记在一张清单里，下一次导入先按清单收掉。
enum DataImport {
  struct Source {
    let url: URL
    /// 还开着这份库的 server 进程（看它的单实例锁）。nil = 没人开着。
    let livePID: Int32?
  }

  /// 洗副本时停下来的东西（import-snapshot 的 ImportPreparation）。
  struct Report: Decodable {
    let held: [String: Int]
    let relocated: Int
  }

  struct Failure: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
  }

  /// 数据根里本来就会有的 app 自己的东西：导入前它们可以在，源目录里同名的不搬。
  static let appOwned: Set<String> = ["logs", "downloads", ".mac-launch.lock", ".DS_Store"]
  private static let journalName = ".import-publishing.json"
  private static let stagingPrefix = ".import-staging-"

  /// 看一眼这份目录能不能导：有库、和 app 的数据根互不包含、不是多人模式。
  static func inspect(_ url: URL) throws -> Source {
    let db = url.appendingPathComponent("ash.db")
    guard FileManager.default.fileExists(atPath: db.path) else {
      throw Failure("\(url.path) 里没有 ash.db。要选的是 ash 的数据目录（仓库里是 data/）。")
    }
    let source = AshHealth.realPath(url.path), dest = AshHealth.realPath(AshConfig.dataURL.path)
    guard source != dest else { throw Failure("这就是 app 自己的数据目录。") }
    // 互相包含时，复制的一边会把另一边也卷进去（目标在源里面 = 把自己拷进自己）。
    guard !contains(source, dest) && !contains(dest, source) else {
      throw Failure("\(url.path) 和 app 的数据目录 \(AshConfig.dataURL.path) 一个在另一个里面，没法导入。")
    }
    // 多人模式的数据转不回自用（server 的 auth/mode.ts），而 app 只以本机自用模式起服务。
    if try instanceMode(of: db) == "multi" {
      throw Failure("这份数据是多人模式的。app 只以本机自用模式运行，多人数据转不回自用，没法导入。")
    }
    return Source(url: url, livePID: livePID(lock: url.appendingPathComponent("ash.db.ash.lock")))
  }

  /// 导进 `dest`（app 的数据根）。数据根在这期间被别人用上了就整次作罢，那份数据一个字节不碰。
  static func run(_ source: Source, into dest: URL, lockTimeout: TimeInterval = 60) throws -> Report {
    let fm = FileManager.default
    try fm.createDirectory(at: dest, withIntermediateDirectories: true)
    // 先看一眼，省得白拷一趟；作数的那一次在锁里（publish）。锁外不收任何残留：另一处可能正在发布。
    try requireNoDatabase(dest)
    let staging = dest.appendingPathComponent("\(stagingPrefix)\(getpid())-\(UUID().uuidString)", isDirectory: true)
    defer { try? fm.removeItem(at: staging) }
    try fm.createDirectory(at: staging, withIntermediateDirectories: false)
    for name in try fm.contentsOfDirectory(atPath: source.url.path) where !skipped(name) {
      try fm.copyItem(at: source.url.appendingPathComponent(name), to: staging.appendingPathComponent(name))
    }
    let db = staging.appendingPathComponent("ash.db")
    try backup(from: source.url.appendingPathComponent("ash.db"), to: db)
    let report = try prepare(db, source: source.url, dest: dest)
    try seal(db)

    let lock = try ServerStartLock(dataDir: dest)
    let deadline = Date().addingTimeInterval(lockTimeout)
    while try !lock.tryAcquire() {
      guard Date() < deadline else { throw Failure("另一处正在启动 ash 服务，等它超时了。这次没有导入，可以重试。") }
      Thread.sleep(forTimeInterval: 0.2)
    }
    try withExtendedLifetime(lock) { try publish(staging, into: dest) }
    return report
  }

  /// 不跟着搬的：库文件本身（另走备份）和它的日志、别人的锁与在线标记、可以重建的缓存、
  /// app 自己放在数据根里的东西，以及别的导入留下的暂存。
  static func skipped(_ name: String) -> Bool {
    let exact: Set<String> = ["ash.db", "ash.db-wal", "ash.db-shm", "ash.db-journal", "deps", "tmp", journalName]
    return exact.contains(name) || appOwned.contains(name) || name.hasPrefix(stagingPrefix)
      || name.hasSuffix(".ash.lock") || name.contains(".ash-online.")
  }

  // MARK: 发布

  /// 在锁里：数据根还空着才发布。挪进去的条目先记清单，库最后挪，挪完清单作废。
  private static func publish(_ staging: URL, into dest: URL) throws {
    let fm = FileManager.default
    try requireEmpty(dest, except: staging.lastPathComponent)
    // 库是单个文件（seal）；它旁边残留的 -shm 只是共享内存索引，不跟着挪。
    let entries = try fm.contentsOfDirectory(atPath: staging.path).filter { !["ash.db", "ash.db-shm", "ash.db-journal"].contains($0) }
    guard !entries.contains("ash.db-wal") else { throw Failure("导出来的库还没收成单个文件，没有导入。") }
    let journal = dest.appendingPathComponent(journalName)
    try JSONSerialization.data(withJSONObject: entries).write(to: journal, options: .atomic)
    for name in entries {
      try fm.moveItem(at: staging.appendingPathComponent(name), to: dest.appendingPathComponent(name))
    }
    try fm.moveItem(at: staging.appendingPathComponent("ash.db"), to: dest.appendingPathComponent("ash.db"))
    try? fm.removeItem(at: journal)
  }

  /// 数据根里没有库、除了 app 自己的东西也没有别的。上一次挪到一半的（清单上那些）和已经没人在写的
  /// 暂存目录是导入自己的残留，先收掉；剩下认不出来的一律不碰，改为拒绝导入。
  private static func requireEmpty(_ dest: URL, except ownStaging: String) throws {
    let fm = FileManager.default
    try requireNoDatabase(dest)
    let journal = dest.appendingPathComponent(journalName)
    if let data = try? Data(contentsOf: journal), let names = try? JSONSerialization.jsonObject(with: data) as? [String] {
      for name in names where !name.contains("/") && !appOwned.contains(name) {
        try? fm.removeItem(at: dest.appendingPathComponent(name))
      }
      try fm.removeItem(at: journal)
    }
    var strangers: [String] = []
    for name in try fm.contentsOfDirectory(atPath: dest.path) where !appOwned.contains(name) && name != ownStaging {
      if name.hasPrefix(stagingPrefix), let pid = Int32(name.dropFirst(stagingPrefix.count).prefix { $0 != "-" }) {
        if kill(pid, 0) != 0 && errno == ESRCH { try? fm.removeItem(at: dest.appendingPathComponent(name)) }
        continue
      }
      strangers.append(name)
    }
    guard strangers.isEmpty else {
      throw Failure("\(dest.path) 里已经有别的东西（\(strangers.sorted().prefix(6).joined(separator: "、"))），"
        + "导入只往空的数据目录里放。先把它们挪走再导入。")
    }
  }

  private static func requireNoDatabase(_ dest: URL) throws {
    guard !FileManager.default.fileExists(atPath: dest.appendingPathComponent("ash.db").path) else {
      throw Failure("\(dest.path) 里已经有一份 ash 数据了（可能另一个窗口或登录项刚点了「全新开始」）。这次没有导入，那份数据没有动。")
    }
  }

  // MARK: 洗副本

  /// 自带 node 跑 server 的 import-snapshot：源数据根按选的路径和它的真实路径各给一份。
  private static func prepare(_ db: URL, source: URL, dest: URL) throws -> Report {
    for part in [AshConfig.nodeURL, AshConfig.importToolURL] where !FileManager.default.fileExists(atPath: part.path) {
      throw Failure("app 里自带的 ash 不完整（缺 \(part.path)）。重新装一次 Ash.app。")
    }
    let roots = Array(Set([source.standardizedFileURL.path, AshHealth.realPath(source.path)]))
    let tool = Process()
    tool.executableURL = AshConfig.nodeURL
    tool.arguments = [AshConfig.importToolURL.path, db.path, dest.standardizedFileURL.path] + roots
    tool.environment = ["PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory(), "LANG": "en_US.UTF-8"]
    let output = Pipe(), errors = Pipe()
    tool.standardOutput = output
    tool.standardError = errors
    tool.standardInput = FileHandle.nullDevice
    try tool.run()
    let printed = output.fileHandleForReading.readDataToEndOfFile()
    let complaint = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    tool.waitUntilExit()
    guard tool.terminationStatus == 0, let report = try? JSONDecoder().decode(Report.self, from: printed) else {
      throw Failure("整理导入的数据失败（退出码 \(tool.terminationStatus)）：\(complaint.suffix(600))")
    }
    return report
  }

  /// 发布前最后一道：库是好的，而且是单个文件（不带 -wal/-shm，挪一个文件就是整份）。
  private static func seal(_ db: URL) throws {
    let handle = try open(db, flags: SQLITE_OPEN_READWRITE)
    defer { sqlite3_close(handle) }
    guard scalar(handle, "pragma quick_check") == "ok" else {
      throw Failure("导出来的库没通过完整性检查，没有导入。")
    }
    guard scalar(handle, "pragma journal_mode=DELETE")?.lowercased() == "delete" else {
      throw Failure("导出来的库收不成单个文件：\(String(cString: sqlite3_errmsg(handle)))")
    }
  }

  // MARK: SQLite

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
  }

  private static func scalar(_ handle: OpaquePointer, _ sql: String) -> String? {
    var statement: OpaquePointer?
    defer { sqlite3_finalize(statement) }
    guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, sqlite3_step(statement) == SQLITE_ROW,
          let text = sqlite3_column_text(statement, 0) else { return nil }
    return String(cString: text)
  }

  /// 只读打开 WAL 模式的库要 -shm 在（或者能建）；源实例正常停掉之后 -wal、-shm 都收掉了，只读那一下
  /// 就打不开。那时主文件已经是完整的一份，按 immutable 读（不建 -shm、不碰源目录）。
  private static func open(_ url: URL, flags: Int32) throws -> OpaquePointer {
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

  private static func contains(_ outer: String, _ inner: String) -> Bool {
    inner.hasPrefix(outer.hasSuffix("/") ? outer : outer + "/")
  }

  /// server 的单实例锁是 JSON，`pid` 那一项还活着就是有人开着这份库。
  private static func livePID(lock: URL) -> Int32? {
    guard let data = try? Data(contentsOf: lock),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let pid = json["pid"] as? Int, pid > 1, let pid32 = Int32(exactly: pid) else { return nil }
    return kill(pid32, 0) == 0 || errno == EPERM ? pid32 : nil
  }
}
