import Foundation

// scripts/test-macos-update.mjs 的驱动：编进来的是真的 UpdateGate / RestartImpact / ServerShutdown /
// Maintenance / DatabaseBackup / ServerRecord / ServerLauncher，问用户那一下换成照脚本作答
// （ANSWERS=wait,now,…），每一步打一行给测试读。配置全走环境变量（ASH_URL、ASH_DATA_DIR、
// ASH_MAC_RUNTIME），碰不到日常那一份。

let env = ProcessInfo.processInfo.environment
var answers = (env["ANSWERS"] ?? "").split(separator: ",").map(String.init).filter { !$0.isEmpty }

func emit(_ line: String) {
  print(line)
  fflush(stdout)
}

func runUntil(_ seconds: Double, _ done: () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(seconds)
  while !done() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
  return done()
}

let gate = UpdateGate.shared
gate.pollInterval = 0.2
gate.shutdownTimeout = Double(env["SHUTDOWN_TIMEOUT"] ?? "5")!
gate.lockTimeout = Double(env["LOCK_TIMEOUT"] ?? "5")!
gate.ask = { prompt in
  emit("ASK \(prompt.title) | \(prompt.detail.replacingOccurrences(of: "\n", with: " / ")) | \(prompt.buttons.joined(separator: ","))")
  guard !answers.isEmpty else {
    emit("UNEXPECTED ASK")
    exit(3)
  }
  switch answers.removeFirst() {
  case "wait": return .wait
  case "now": return .now
  default: return .cancel
  }
}
gate.report = { emit("REPORT \($0)") }
gate.onHoldChanged = { emit($0.map { "HOLD \($0)" } ?? "RELEASE") }

let args = CommandLine.arguments
switch args[1] {
case "update", "stale":
  var proceeded = false
  var reported = false
  let report = gate.report
  gate.report = { report($0); reported = true }
  let purpose: UpdateGate.Purpose = args[1] == "update" ? .update(version: "9.9（99999999.0000）") : .staleServer(from: "old")
  gate.request(purpose) { proceeded = true; emit("PROCEED") }
  _ = runUntil(Double(args[2])!) { proceeded || reported }
  emit("PHASE \(gate.phase) LAUNCH-HOLD \(ServerLauncher.shared.hold ?? "none")")
  exit(proceeded ? 0 : reported ? 1 : 2)

case "quit":
  var reply: Bool?
  var drained = false
  gate.requestForQuit(version: "9.9", whenDrained: { drained = true; emit("DRAINED") }) { allowed in
    reply = allowed
    emit("REPLY \(allowed)")
  }
  // 「等」那一场要一直等到排空；其余拿到答复就完。
  let untilDrained = args.count > 3 && args[3] == "drain"
  _ = runUntil(Double(args[2])!) { drained || (reply != nil && (reply == true || !untilDrained)) }
  exit(drained || reply == true ? 0 : 1)

case "abandon-prepared":
  // 放行之后 Sparkle 中止：闸收回、启动禁令解除；再要装时从头评估、再备份一次。
  var proceeded = 0
  gate.request(.update(version: "9.9")) { proceeded += 1; emit("PROCEED") }
  _ = runUntil(Double(args[2])!) { proceeded == 1 }
  gate.abandon("测试里的安装错误")
  emit("PHASE \(gate.phase) PENDING \(gate.hasPending) LAUNCH-HOLD \(ServerLauncher.shared.hold ?? "none")")
  _ = runUntil(1.1) { false }  // 备份文件名精确到秒：隔开一秒，看得出重试又备了一份
  gate.request(.update(version: "9.9")) { proceeded += 1; emit("PROCEED") }
  _ = runUntil(Double(args[2])!) { proceeded == 2 }
  exit(proceeded == 2 ? 0 : 1)

case "abandon-waiting":
  // 在等任务跑完的时候 Sparkle 放弃了：排着的安装回调作废，之后排空了也不再放行。
  var proceeded = false
  gate.request(.update(version: "9.9")) { proceeded = true; emit("PROCEED") }
  _ = runUntil(Double(args[2])!) { gate.phase == .waiting }
  gate.abandon("测试里的下载错误")
  emit("ABANDONED")
  _ = runUntil(Double(args[3])!) { proceeded }
  emit("PHASE \(gate.phase) PENDING \(gate.hasPending)")
  exit(proceeded ? 1 : 0)

case "stop":
  // ServerShutdown 只停评估过的那一份：stop <ours:pid | absent | consented>
  let spec = args[2]
  let target: ServiceTarget? = spec == "absent" ? .absent : spec == "consented" ? nil : .ours(pid: Int(spec.dropFirst(5))!)
  emit("STOP \(ServerShutdown.stop(expecting: target, timeout: 3))")

case "maintain":
  // 攥着维护期不放，直到被杀（看另一个进程里的启动器认不认它）。
  let held = try! Maintenance.begin(note: "测试里的维护", timeout: 2)
  emit("MAINTAINING")
  _ = runUntil(Double(args[2])!) { false }
  held.end()
  emit("ENDED")

case "launch":
  ServerLauncher.shared.freshStartApproved = true
  switch ServerLauncher.shared.ensureRunningSync(timeout: Double(args[2])!) {
  case .ready: emit("LAUNCH ready")
  case .needsSetup: emit("LAUNCH needs-setup")
  case .occupied(let why): emit("LAUNCH occupied \(why)")
  case .failed(let why): emit("LAUNCH failed \(why.replacingOccurrences(of: "\n", with: " / "))")
  }

case "record":
  ServerRecord.write(pid: Int(args[2])!)
  // 测试按需把构建号改成别的，模拟「旧版 app 起的」。
  if args.count > 3 {
    let data = try! JSONEncoder().encode(ServerRecord(pid: Int(args[2])!, bundleVersion: args[3]))
    try! data.write(to: ServerRecord.url)
  }
  emit("STALE \(ServerRecord.staleVersion(servingPID: Int(args[2])!) ?? "none")")
  emit("STALE-OTHER-PID \(ServerRecord.staleVersion(servingPID: Int(args[2])! + 1) ?? "none")")

case "backups":
  // 连做 n 份（时间各差一秒），看只留最近几份、名字按时间排。
  let count = Int(args[2])!
  for i in 0..<count {
    let made = try! DatabaseBackup.beforeUpdate(fromVersion: "v\(i)", now: Date(timeIntervalSince1970: 1_800_000_000 + Double(i)))
    emit("MADE \(made?.lastPathComponent ?? "nil")")
  }
  emit("KEPT \(DatabaseBackup.existing().map(\.lastPathComponent).joined(separator: ","))")
  emit("PINNED \(DatabaseBackup.recoveryPoint()?.lastPathComponent ?? "none")")

case "backups-same-second":
  let now = Date(timeIntervalSince1970: 1_900_000_000)
  let first = try! DatabaseBackup.beforeUpdate(fromVersion: "same", now: now)!
  let second = try! DatabaseBackup.beforeUpdate(fromVersion: "same", now: now)!
  emit("SAME-SECOND \(first.lastPathComponent),\(second.lastPathComponent)")

default:
  emit("unknown mode")
  exit(64)
}
