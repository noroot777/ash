import Foundation

// scripts/test-macos-update.mjs 的驱动：编进来的是真的 UpdateGate / RestartImpact / ServerShutdown /
// DatabaseBackup / ServerRecord，问用户那一下换成照脚本作答（ANSWERS=wait,now,…），每一步打一行
// 给测试读。配置全走环境变量（ASH_URL、ASH_DATA_DIR），碰不到日常那一份。

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

default:
  emit("unknown mode")
  exit(64)
}
