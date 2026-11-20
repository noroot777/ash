import Foundation
import Darwin

enum RuntimeRecovery {
  struct Record: Codable {
    let previous: String
    let next: String
    let backup: String?
    let server: ServerRecord?
    let finalized: Bool?
    var adopting = false
  }
  static var url: URL { NaviConfig.dataURL.appendingPathComponent(".mac-runtime-recovery.json") }

  static func record(previous: String, backup: URL?, finalized: Bool = false) throws {
    guard RuntimeStore.contains(previous) else { throw SQLiteFile.Failure("旧运行时身份不符") }
    let record = Record(previous: NaviHealth.realPath(previous), next: NaviHealth.realPath(NaviConfig.targetRuntimeURL.path),
                        backup: backup?.path, server: ServerRecord.read(), finalized: finalized)
    try JSONEncoder().encode(record).write(to: url, options: .atomic)
  }

  static func confirmed(_ instance: NaviInstance) {
    guard instance.isOurs, let code = instance.codeDir,
          let data = try? Data(contentsOf: url), let record = try? JSONDecoder().decode(Record.self, from: data),
          NaviHealth.samePath(record.next, code) else { return }
    try? FileManager.default.removeItem(at: url)
  }

  static func restoreBeforeAdoption() throws -> URL? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    let record = try JSONDecoder().decode(Record.self, from: data)
    guard case .down = NaviHealth.probeSync(), NaviHealth.samePath(record.next, NaviConfig.targetRuntimeURL.path),
          RuntimeStore.contains(record.previous), !record.adopting, record.finalized == true else {
      throw SQLiteFile.Failure("新版已开始接管或恢复身份不符，未自动覆盖数据库；迁移前恢复点仍保留。")
    }
    if let backup = record.backup, let database = try DatabaseFile.existing(in: NaviConfig.dataURL) {
      guard NaviHealth.samePath(URL(fileURLWithPath: backup).deletingLastPathComponent().path, NaviConfig.backupURL.path) else {
        throw SQLiteFile.Failure("恢复点不属于本数据根")
      }
      let stage = database.appendingPathExtension("restoring-" + UUID().uuidString)
      defer { try? FileManager.default.removeItem(at: stage) }
      try SQLiteFile.snapshot(from: URL(fileURLWithPath: backup), to: stage)
      try SQLiteFile.snapshot(from: database, to: database.appendingPathExtension("failed-" + UUID().uuidString))
      guard rename(stage.path, database.path) == 0 else { throw SQLiteFile.Failure("无法发布恢复后的数据库") }
      for suffix in ["-wal", "-shm", "-journal"] { try? FileManager.default.removeItem(atPath: database.path + suffix) }
    }
    let previous = URL(fileURLWithPath: record.previous, isDirectory: true)
    try RuntimeStore.activate(previous)
    if let server = record.server { try JSONEncoder().encode(server).write(to: ServerRecord.url, options: .atomic) }
    try FileManager.default.removeItem(at: url)
    return previous
  }
}
