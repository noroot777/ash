import Foundation
import Sparkle

func emit(_ text: String) { print(text); fflush(stdout) }
func until(_ done: () -> Bool) {
  let deadline = Date().addingTimeInterval(25)
  while !done() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
}

let mode = CommandLine.arguments[1]
let gate = UpdateGate.shared
gate.ask = { prompt in emit("REFUSED \(prompt.detail)"); return .cancel }
gate.report = { emit("REFUSED \($0)") }
gate.shutdownTimeout = 5
gate.lockTimeout = 5
switch mode {
case "prepare":
  do { try RuntimeStore.prepare(); emit("RUNTIME \(NaviConfig.runtimeURL.path)") } catch { emit("ERROR \(error)"); exit(1) }
case "collect":
  try RuntimeStore.prepare()
  RuntimeStore.reclaim()
case "unfinalized-recovery":
  try RuntimeStore.prepare()
  try RuntimeRecovery.record(previous: NaviConfig.runtimeURL.path, backup: nil)
  do {
    _ = try RuntimeRecovery.restoreBeforeAdoption()
    emit("ERROR restored an online snapshot")
    exit(1)
  } catch { emit("REFUSED online snapshot") }
  try FileManager.default.removeItem(at: RuntimeRecovery.url)
case "start":
  ServerLauncher.shared.freshStartApproved = true
  emit("START \(ServerLauncher.shared.ensureRunningSync(timeout: 20))")
case "switch":
  try RuntimeStore.prepare()
  var proceeded = false
  var refused = false
  gate.report = { emit("REFUSED \($0)"); refused = true }
  gate.request(.staleServer(from: "test")) { proceeded = true }
  until { proceeded || refused || gate.phase == .waiting }
  guard proceeded else { emit("SWITCH blocked phase=\(gate.phase)"); exit(2) }
  emit("START \(ServerLauncher.shared.ensureRunningSync(timeout: 20))")
case "blocked":
  try RuntimeStore.prepare()
  switch RestartImpactProbe.assessSync(preservingRuntime: true) {
  case .disrupts(_, let items): emit("BLOCKED \(items.map { $0.why }.joined(separator: "；"))")
  case .unknown(let reason): emit("BLOCKED \(reason)")
  case .clear: emit("ERROR preflight allowed"); exit(1)
  }
  var proceeded = false
  var holds = 0
  gate.pollInterval = 0.05
  gate.onHoldChanged = { if $0 != nil { holds += 1 } }
  gate.ask = { emit("BLOCKED \($0.detail)"); return .wait }
  gate.request(.staleServer(from: "test")) { proceeded = true }
  until { gate.phase == .waiting || proceeded }
  let deadline = Date().addingTimeInterval(0.5)
  while Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
  guard !proceeded, holds == 0, gate.phase == .waiting else { emit("ERROR repeated hold \(holds)"); exit(1) }
  emit("WAITING WITHOUT HOLD")
case "sparkle-relaunch", "sparkle-quit", "sparkle-abort":
  let updater = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: nil, userDriverDelegate: nil).updater
  let item = SUAppcastItem(dictionary: ["enclosure": ["url": "https://example.invalid/Navi.zip", "sparkle:version": "2"]])!
  var proceeded = false
  if mode == "sparkle-quit" {
    _ = AppUpdater.shared.updater(updater, willInstallUpdateOnQuit: item) { proceeded = true }
  } else {
    _ = AppUpdater.shared.updater(updater, shouldPostponeRelaunchForUpdate: item) { proceeded = true }
  }
  until { proceeded }
  guard proceeded else { exit(2) }
  emit("PROCEED")
  if mode == "sparkle-abort" {
    AppUpdater.shared.updater(updater, didAbortWithError: NSError(domain: "SUErrorDomain", code: 4000))
    emit("ABORT \(gate.phase) \(ServerLauncher.shared.hold ?? "none")")
  }
default: exit(3)
}
