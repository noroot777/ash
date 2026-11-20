import Foundation

func emit(_ text: String) { print(text); fflush(stdout) }
let mode = CommandLine.arguments[1]
guard DataImport.skipped(".mac-runtimes") else { exit(4) }
let gate = UpdateGate.shared
gate.pollInterval = 0.1
gate.shutdownTimeout = 3
gate.lockTimeout = 3
gate.ask = { _ in emit("UNEXPECTED ASK"); exit(3) }
var finished = false
gate.report = { emit("FAILED \($0)"); finished = true }
if mode == "prepare" {
  do { try RuntimeStore.prepare(); emit("READY \(NaviConfig.runtimeURL.path)") }
  catch { emit("FAILED \(error.localizedDescription)"); exit(1) }
} else {
  if mode == "stale" {
    do { try RuntimeStore.prepare() } catch { emit("FAILED \(error)"); exit(1) }
  }
  gate.request(mode == "stale" ? .staleServer(from: "old") : .update(version: "new")) {
    emit("PROCEED")
    finished = true
  }
  let deadline = Date().addingTimeInterval(8)
  while !finished && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
  if !finished { emit("WAITING \(gate.pendingMenuTitle)") }
  if mode == "abort" {
    gate.abandon("simulated Sparkle failure")
    emit("ABANDONED \(gate.phase == .idle)")
  }
}
