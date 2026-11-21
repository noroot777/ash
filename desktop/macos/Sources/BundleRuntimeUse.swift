import Foundation
import Darwin

enum BundleRuntimeUse {
  static func verify() throws {
    let resources = NaviConfig.bundledRuntimeURL.deletingLastPathComponent()
    let scan = Process()
    scan.executableURL = URL(fileURLWithPath: "/bin/bash")
    scan.arguments = [resources.appendingPathComponent("bundle-users.sh").path,
                      resources.deletingLastPathComponent().deletingLastPathComponent().path]
    let output = Pipe()
    scan.standardOutput = output
    scan.standardError = FileHandle.nullDevice
    try scan.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    scan.waitUntilExit()
    let users = String(decoding: data, as: UTF8.self).split(separator: "\n").filter { !installer($0, resources: resources) }
    guard scan.terminationStatus == 0, users.isEmpty else {
      throw SQLiteFile.Failure("仍有进程使用 app 包或无法确认：\(users.joined(separator: "\n"))")
    }
  }

  private static func installer(_ line: Substring, resources: URL) -> Bool {
    guard let word = line.split(whereSeparator: { $0.isWhitespace }).first, let pid = Int32(word), pid > 1 else { return false }
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return false }
    let actual = NaviHealth.realPath(String(cString: buffer))
    let framework = resources.deletingLastPathComponent().appendingPathComponent("Frameworks/Sparkle.framework/Versions/Current")
    return ["Autoupdate", "Updater.app/Contents/MacOS/Updater",
      "XPCServices/InstallerLauncher.xpc/Contents/MacOS/InstallerLauncher"].contains {
      actual == NaviHealth.realPath(framework.appendingPathComponent($0).path)
    }
  }
}
