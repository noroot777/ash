import Foundation
import Darwin

// scripts/test-macos-client.mjs 的驱动：编进来的是真的 NaviConfig / NaviHealth / ServerLauncher /
// DataImport，配置全走环境变量（NAVI_URL、NAVI_DATA_DIR、NAVI_MAC_RUNTIME、NAVI_MAC_DOWNLOAD_JOURNAL），
// 碰不到日常那一份 app 的数据。

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
  case .needsSetup:
    print("NEEDS SETUP")
    return 3
  case .occupied(let explanation):
    print("OCCUPIED: \(explanation)")
    return 2
  case .failed(let reason):
    print("FAILED: \(reason)")
    return 1
  }
}

let mode = CommandLine.arguments[1]
if mode == "start" || mode == "start-fresh" {
  ServerLauncher.shared.freshStartApproved = mode == "start-fresh"
  exit(outcomeCode(ServerLauncher.shared.ensureRunningSync(timeout: Double(CommandLine.arguments[2])!)))
}
if mode == "coalesce" {
  ServerLauncher.shared.freshStartApproved = true
  var received = 0
  var failed = false
  for _ in 0..<8 {
    ServerLauncher.shared.ensureRunning(timeout: 5) { outcome in
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
if mode == "config" {
  // 环境变量各代怎么认：新名优先、退到旧名，指向数据的两代打架就拒绝。
  if let conflict = NaviConfig.environmentConflict { print("CONFLICT \(conflict)"); exit(1) }
  print("url=\(NaviConfig.baseURL.absoluteString)")
  print("data=\(NaviConfig.dataURL.path)")
  print("window=\(NaviConfig.windowPort)")
  print("runtime=\(NaviConfig.runtimeURL.path)")
  print("journal=\(NaviConfig.downloadJournalURL.path)")
  exit(0)
}
if mode == "health" {
  // 窗口从占位页恢复用的就是这一次探测 + isServing。
  let probe = NaviHealth.probeSync()
  switch probe {
  case .down: print("DOWN")
  case .unreachable(let why): print("UNREACHABLE \(why)")
  case .notNavi: print("NOT NAVI")
  case .navi: print(NaviHealth.isServing(probe) ? "READY" : "FOREIGN")
  }
  exit(0)
}
if mode == "import-inspect" || mode == "import" {
  do {
    let source = try DataImport.inspect(URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true))
    var held = ""
    if mode == "import" {
      let report = try DataImport.run(source, into: NaviConfig.dataURL, lockTimeout: Double(CommandLine.arguments.dropFirst(3).first ?? "") ?? 60)
      held = " held=\(report.held.sorted { $0.key < $1.key }.map { "\($0.key):\($0.value)" }.joined(separator: ",")) relocated=\(report.relocated) skipped=\(report.skippedSpecial)"
    }
    print("OK live=\(source.livePID.map(String.init) ?? "none")\(held)")
    exit(0)
  } catch {
    print("REFUSED: \(error.localizedDescription)")
    exit(1)
  }
}
if mode == "reclaim" {
  DownloadTransaction.reclaimAbandoned()
  exit(0)
}
if mode == "chrome" {
  runWindowChromeProbe()
}
if mode == "guard" {
  runInstanceGuardProbe(mode: CommandLine.arguments[2])
}
if mode == "deeplink" {
  // navi:// 链接：只收认得的形状；自家服务指纹对上才在窗口里开，对不上 / 认不出交给浏览器。
  let fallback = "http://mbp.tail97f3a6.ts.net:4317/?project=p_1&task=t-2"
  let encoded = fallback.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
  let full = DeepLink.parse(URL(string: "navi://open?project=p_1&task=t-2&instance=AB12-CD34&fallback=\(encoded)")!)
  require(full == DeepLink.Link(route: "/?project=p_1&task=t-2", instance: "AB12-CD34", fallback: URL(string: fallback)), "full link parses")
  require(DeepLink.decide(full!, servedTag: "AB12-CD34") == .window("/?project=p_1&task=t-2"), "same instance opens in the window")
  require(DeepLink.decide(full!, servedTag: "FFFF-0000") == .browser(URL(string: fallback)!), "another instance goes to the http fallback")
  require(DeepLink.decide(full!, servedTag: nil) == .browser(URL(string: fallback)!), "unconfirmed service goes to the http fallback")
  let bare = DeepLink.parse(URL(string: "navi://open?project=p_1")!)!
  require(DeepLink.decide(bare, servedTag: "AB12-CD34") == .window("/?project=p_1"), "a link without origin opens in our window")
  require(DeepLink.decide(bare, servedTag: nil) == .front, "nothing to fall back to: only bring the window forward")
  for bad in ["navi://open?task=t", "navi://open?project=a%22b", "navi://other?project=p", "https://x/?project=p",
              "navi://open?project=p&instance=nope", "navi://open?project=p&fallback=file%3A%2F%2F%2Fetc%2Fpasswd",
              "navi://open?project=p&task=t&fallback=\("https://evil.example/?project=p&task=other".addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)"] {
    require(DeepLink.parse(URL(string: bad)!) == nil, "rejects \(bad)")
  }
  // 在跑的服务没按菜单上的设置起：看得出来。设置由调用方经参数域给（-NaviAllowOtherDevices NO），不写 defaults。
  require(!NaviConfig.allowsOtherDevices, "driver runs with other devices not allowed")
  let served = { (localOnly: Bool) in
    NaviInstance(pid: 1, id: "i", dataDir: "/d", codeDir: "/c", localOnly: localOnly, desktop: true, tag: nil, windowPort: 1)
  }
  require(!ServedInstance.networkPending, "unknown service is not reported as pending")
  ServedInstance.observe(served(false))
  require(ServedInstance.networkPending, "local-only wanted, service listens everywhere: pending")
  ServedInstance.observe(served(true))
  require(!ServedInstance.networkPending, "service started local-only matches")
  ServedInstance.observe(served(false))
  ServedInstance.forget()
  require(!ServedInstance.networkPending, "forgotten service is unknown again")
  print("DEEPLINK OK")
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
