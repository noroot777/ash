import Foundation
import Darwin

enum AshConfig {
  static let baseURL = URL(string: ProcessInfo.processInfo.environment["ASH_URL"]!)!
  static var healthURL: URL { baseURL.appendingPathComponent("api/health") }
  static var repoURL: URL? {
    ProcessInfo.processInfo.environment["ASH_TEST_REPO"].map { URL(fileURLWithPath: $0) }
  }
  static var downloadJournalURL: URL {
    URL(fileURLWithPath: ProcessInfo.processInfo.environment["ASH_TEST_JOURNAL"]!, isDirectory: true)
  }
}

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else {
    fputs("FAIL: \(message)\n", stderr)
    exit(1)
  }
}

func outcomeCode(_ outcome: ServerLauncher.Outcome) -> Int32 {
  switch outcome {
  case .ready:
    print("READY")
    return 0
  case .failed(let reason):
    print("FAILED: \(reason)")
    return 1
  }
}

let mode = CommandLine.arguments[1]
if mode == "start" {
  exit(outcomeCode(ServerLauncher.shared.ensureRunningSync(timeout: Double(CommandLine.arguments[2])!)))
}
if mode == "coalesce" {
  var received = 0
  var failed = false
  for _ in 0..<8 {
    ServerLauncher.shared.ensureRunning(timeout: 1) { outcome in
      failed = outcomeCode(outcome) != 0 || failed
      received += 1
    }
  }
  let deadline = Date().addingTimeInterval(30)
  while received < 8 && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
  require(received == 8, "every merged request receives a result")
  require(failed, "fixture intentionally fails")
  exit(0)
}
if mode == "health" {
  // 窗口从占位页恢复用的就是这一次不带 pid 的探测。
  let done = DispatchSemaphore(value: 0)
  var ready = false
  AshHealth.probe { ready = $0; done.signal() }
  done.wait()
  print(ready ? "READY" : "NOT READY")
  exit(0)
}
if mode == "reclaim" {
  DownloadTransaction.reclaimAbandoned()
  exit(0)
}
if mode == "lock" {
  print(try ServerStartLock.path(repo: AshConfig.repoURL!, port: AshConfig.baseURL.port!))
  exit(0)
}

let destination = URL(fileURLWithPath: CommandLine.arguments[2])
if mode == "pending" {
  let transaction = try DownloadTransaction(destination: destination)
  try Data("unfinished".utf8).write(to: transaction.temporaryURL)
  print("PENDING")
  fflush(stdout)
  Thread.sleep(forTimeInterval: 60)
  withExtendedLifetime(transaction) {}
  exit(0)
}

func contents(_ url: URL) -> String { (try? String(contentsOf: url, encoding: .utf8)) ?? "" }

try Data("original".utf8).write(to: destination)
do {
  let transaction = try DownloadTransaction(destination: destination)
  try Data("partial".utf8).write(to: transaction.temporaryURL)
  require(contents(destination) == "original", "partial download must preserve old file")
  transaction.discard()
  require(contents(destination) == "original", "failed download must preserve old file")
  require(!FileManager.default.fileExists(atPath: transaction.temporaryURL.path), "discard removes staging")
}
do {
  let transaction = try DownloadTransaction(destination: destination)
  do {
    try transaction.commit()
    require(false, "missing download must fail")
  } catch {
    require(contents(destination) == "original", "failed commit must preserve old file")
  }
}
do {
  let transaction = try DownloadTransaction(destination: destination)
  try Data("complete".utf8).write(to: transaction.temporaryURL)
  try transaction.commit()
  require(contents(destination) == "complete", "finished download replaces old file")
  require(!FileManager.default.fileExists(atPath: transaction.temporaryURL.path), "commit removes staging")
}
let fresh = destination.appendingPathExtension("new")
do {
  let transaction = try DownloadTransaction(destination: fresh)
  try Data("new export".utf8).write(to: transaction.temporaryURL)
  try transaction.commit()
  require(contents(fresh) == "new export", "new destination also commits")
}
let blocked = destination.appendingPathExtension("directory")
try FileManager.default.createDirectory(at: blocked, withIntermediateDirectories: false)
let nested = blocked.appendingPathComponent("old")
try Data("preserved".utf8).write(to: nested)
do {
  let transaction = try DownloadTransaction(destination: blocked)
  try Data("cannot replace directory".utf8).write(to: transaction.temporaryURL)
  do {
    try transaction.commit()
    require(false, "invalid destination must fail")
  } catch {
    require(contents(nested) == "preserved", "rename failure must preserve destination")
  }
}
print("PASS: download transactions")
