import Foundation

func emit(_ text: String) { print(text); fflush(stdout) }
let mode = CommandLine.arguments[1]
guard DataImport.skipped(".mac-runtimes") else { exit(4) }
let gate = UpdateGate.shared
gate.pollInterval = 0.1
gate.shutdownTimeout = 3
gate.lockTimeout = 3
gate.ask = { _ in
  if mode == "legacy-wait" { emit("ASK LEGACY"); return .wait }
  emit("UNEXPECTED ASK"); exit(3)
}
var finished = false
var reports = 0
var holds = 0
gate.report = { emit("FAILED \($0)"); reports += 1; finished = true }
gate.onHoldChanged = { if $0 != nil { holds += 1 } }
if mode == "prepare" {
  do { try RuntimeStore.prepare(); emit("READY \(NaviConfig.runtimeURL.path)") }
  catch { emit("FAILED \(error.localizedDescription)"); exit(1) }
} else {
  if mode == "stale" || mode == "rejected" || mode.hasPrefix("legacy") {
    do { try RuntimeStore.prepare() } catch { emit("FAILED \(error)"); exit(1) }
  }
  gate.request(mode == "stale" || mode == "rejected" || mode.hasPrefix("legacy") ? .staleServer(from: "old") : .update(version: "new")) {
    emit("PROCEED")
    finished = true
  }
  let deadline = Date().addingTimeInterval(8)
  while !finished && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
  if mode == "rejected" {
    let quiet = Date().addingTimeInterval(0.5)
    while Date() < quiet { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    guard reports == 1, holds == 1, gate.phase == .blocked, gate.hasPending else { emit("ERROR automatic retry"); exit(1) }
    finished = false
    gate.reconsider()
    while !finished && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    guard reports == 2, holds == 2, gate.phase == .blocked else { emit("ERROR explicit retry"); exit(1) }
    emit("RETRY explicit blocked")
  }
  if !finished { emit("WAITING \(gate.pendingMenuTitle)") }
  if mode == "abort" {
    gate.abandon("simulated Sparkle failure")
    emit("ABANDONED \(gate.phase == .idle)")
  }
}
