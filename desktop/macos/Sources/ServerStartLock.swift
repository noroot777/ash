import Foundation
import CryptoKit
import Darwin

final class ServerStartLock {
  let descriptor: Int32

  static func path(repo: URL, port: Int) throws -> String {
    guard let resolved = realpath(repo.path, nil) else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    defer { free(resolved) }
    let identity = "\(String(cString: resolved))\n\(port)"
    let hash = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    return "/tmp/ash-server-start-\(getuid())-\(hash).lock"
  }

  init(repo: URL, port: Int) throws {
    descriptor = open(try Self.path(repo: repo, port: port), O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
  }

  func tryAcquire() throws -> Bool {
    if flock(descriptor, LOCK_EX | LOCK_NB) == 0 { return true }
    if errno == EWOULDBLOCK { return false }
    throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
  }

  deinit { close(descriptor) }
}
