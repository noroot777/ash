import Foundation
import Darwin

/// 一次「另存为」：WKDownload 先写进目标旁边的隐藏暂存目录，写完才 rename 换掉目标，
/// 所以下载失败、提交失败、app 中途退出都不会碰坏已有的同名文件。
///
/// 暂存目录得跟着目标走（rename 不跨卷），于是散在用户选过的各个文件夹里。进程被强杀或断电时
/// commit / discard / deinit 一个都跑不到，它就留在原地 —— 所以每笔事务在
/// `AshConfig.downloadJournalURL` 下留一张登记：文件名是事务 id，内容是暂存目录的路径，事务
/// 存续期间一直持着这张登记的 flock。下次启动 `reclaimAbandoned()` 照登记回收。
///
/// 「这笔还在不在写」只看锁：进程一死内核就放锁。不靠 pid（会被复用），也不靠时间（慢下载会被误删）。
final class DownloadTransaction {
  let destination: URL
  let temporaryURL: URL
  private let directory: URL
  private let journal: URL
  private var journalDescriptor: Int32

  private static let stagingPrefix = ".ash-download-"
  /// 目标文件夹一直不在（外接盘再没插回来、文件夹被删）的登记留多久。
  private static let unreachableRetention: TimeInterval = 30 * 24 * 3600

  init(destination: URL) throws {
    self.destination = destination
    let id = UUID().uuidString
    directory = destination.deletingLastPathComponent()
      .appendingPathComponent(Self.stagingPrefix + id, isDirectory: true)
    temporaryURL = directory.appendingPathComponent("payload")
    journal = AshConfig.downloadJournalURL.appendingPathComponent(id)
    try FileManager.default.createDirectory(at: AshConfig.downloadJournalURL, withIntermediateDirectories: true)
    // 先登记、后建目录：反过来的话，两步之间被杀会留下一个没有登记的目录。
    // O_EXLOCK 让「建出来」和「锁上」是同一步，别的实例的回收插不进这道缝。
    journalDescriptor = open(journal.path, O_CREAT | O_EXCL | O_WRONLY | O_EXLOCK | O_CLOEXEC, 0o600)
    guard journalDescriptor >= 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSFilePathErrorKey: journal.path])
    }
    do {
      try FileHandle(fileDescriptor: journalDescriptor, closeOnDealloc: false)
        .write(contentsOf: Data(directory.path.utf8))
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                              attributes: [.posixPermissions: 0o700])
    } catch {
      discard()
      throw error
    }
  }

  func commit() throws {
    guard rename(temporaryURL.path, destination.path) == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno),
                    userInfo: [NSFilePathErrorKey: destination.path])
    }
    discard()
  }

  func discard() {
    guard journalDescriptor >= 0 else { return }
    // 暂存目录确认没了才销登记；删不掉就留着登记，放锁后由下次启动接着收。
    if Self.removeStaging(directory) { unlink(journal.path) }
    close(journalDescriptor)
    journalDescriptor = -1
  }

  deinit { discard() }

  /// 回收没走完的事务留下的暂存目录。启动时调一次；仍在写的事务（包括别的实例的）持着锁，碰不到。
  static func reclaimAbandoned() {
    let entries = (try? FileManager.default.contentsOfDirectory(
      at: AshConfig.downloadJournalURL, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
    for entry in entries {
      let descriptor = open(entry.path, O_RDONLY | O_CLOEXEC)
      guard descriptor >= 0 else { continue }
      defer { close(descriptor) }
      guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { continue }
      let recorded = String(data: FileHandle(fileDescriptor: descriptor, closeOnDealloc: false).readDataToEndOfFile(),
                            encoding: .utf8) ?? ""
      let staging = URL(fileURLWithPath: recorded, isDirectory: true)
      // 只删自己建得出来的那种目录：名字得和登记的文件名对上。写了一半或被改坏的登记直接作废，
      // 不能让它变成「启动时删任意路径」。
      guard recorded.hasPrefix("/"), staging.lastPathComponent == stagingPrefix + entry.lastPathComponent else {
        unlink(entry.path)
        continue
      }
      let modified = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
      let expired = modified.map { Date().timeIntervalSince($0) > unreachableRetention } ?? false
      if removeStaging(staging) || expired { unlink(entry.path) }
    }
  }

  /// 删掉暂存目录，返回它是否**确认**没了。目标文件夹本身看不到（外接盘拔了）不算确认 ——
  /// 那时「不存在」只是够不着，盘插回来东西还在。
  private static func removeStaging(_ directory: URL) -> Bool {
    let files = FileManager.default
    try? files.removeItem(at: directory)
    return files.fileExists(atPath: directory.deletingLastPathComponent().path)
      && !files.fileExists(atPath: directory.path)
  }
}
