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
  do { emit("RUNTIME \(try RuntimeStore.selected.get().path)") } catch { emit("ERROR \(error)"); exit(1) }
case "collect":
  _ = try RuntimeStore.selected.get()
  RuntimeStore.reclaim()
case "start":
  ServerLauncher.shared.freshStartApproved = true
  emit("START \(ServerLauncher.shared.ensureRunningSync(timeout: 20))")
case "switch":
  var proceeded = false
  var refused = false
  gate.report = { emit("REFUSED \($0)"); refused = true }
  gate.request(.staleServer(from: "test")) { proceeded = true }
  until { proceeded || refused || gate.phase == .waiting }
  guard proceeded else { exit(2) }
  emit("START \(ServerLauncher.shared.ensureRunningSync(timeout: 20))")
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
