import Foundation
import Darwin

final class DownloadTransaction {
  let destination: URL
  let temporaryURL: URL
  private let directory: URL

  init(destination: URL) throws {
    self.destination = destination
    directory = destination.deletingLastPathComponent()
      .appendingPathComponent(".ash-download-\(UUID().uuidString)", isDirectory: true)
    temporaryURL = directory.appendingPathComponent("payload")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                          attributes: [.posixPermissions: 0o700])
  }

  func commit() throws {
    guard rename(temporaryURL.path, destination.path) == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno),
                    userInfo: [NSFilePathErrorKey: destination.path])
    }
    discard()
  }

  func discard() {
    try? FileManager.default.removeItem(at: directory)
  }

  deinit { discard() }
}
