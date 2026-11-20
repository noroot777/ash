import Foundation

struct ServiceRecoveryIdentity {
  let id: String
  let pid: Int
  let dataDir: String
  let codeDir: String

  init?(_ instance: NaviInstance) {
    guard NaviConfig.isLocal, instance.isOurs, let id = instance.id, !id.isEmpty,
          let pid = instance.pid, pid > 1, let dataDir = instance.dataDir,
          let codeDir = instance.codeDir, RuntimeStore.contains(codeDir) else { return nil }
    self.id = id
    self.pid = pid
    self.dataDir = NaviHealth.realPath(dataDir)
    self.codeDir = NaviHealth.realPath(codeDir)
  }

  func matches(_ instance: NaviInstance) -> Bool {
    guard let current = ServiceRecoveryIdentity(instance) else { return false }
    return id == current.id && pid == current.pid && dataDir == current.dataDir && codeDir == current.codeDir
  }

  func verify() throws {
    guard case .navi(let instance) = NaviHealth.probeSync(), matches(instance) else {
      throw SQLiteFile.Failure("服务身份已变化或无法确认，本次强制切换已取消；没有停止其他服务。")
    }
  }
}
