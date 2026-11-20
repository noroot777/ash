import AppKit
import SQLite3

let environment = ProcessInfo.processInfo.environment
var answers = (environment["ANSWERS"] ?? "").split(separator: ",").map(String.init)
let gate = UpdateGate.shared
gate.shutdownTimeout = 0.4
gate.lockTimeout = 0.4
gate.pollInterval = 60
var proceeded = false
var reported = false
var promptCount = 0
var heldLock: ServerStartLock?
var bundleLock: Int32 = -1

func emit(_ value: String) { print(value); fflush(stdout) }

if environment["HOLD_START_LOCK"] == "1" {
  heldLock = try ServerStartLock(dataDir: NaviConfig.dataURL)
  let acquired = try heldLock!.tryAcquire()
  precondition(acquired)
}
if environment["HOLD_BUNDLE_LOCK"] == "1" {
  bundleLock = open(NaviConfig.bundledRuntimeURL.appendingPathComponent(".in-use").path, O_RDONLY | O_SHLOCK | O_NONBLOCK)
  precondition(bundleLock >= 0)
}

gate.ask = { prompt in
  promptCount += 1
  emit("PROMPT \(promptCount) \(prompt.title) | \(prompt.detail.replacingOccurrences(of: "\n", with: " / ")) | \(prompt.affectedTasks.joined(separator: " / ")) | \(prompt.buttons.joined(separator: "|"))")
  precondition(!answers.isEmpty, "Unexpected prompt")
  let answer = answers.removeFirst()
  let choice: UpdateGate.Choice
  switch answer {
  case "recover": choice = .recover
  case "wait": choice = .wait
  case "quit": choice = .quit
  default: choice = .cancel
  }
  precondition(prompt.choices.contains(choice), "Answer not offered: \(answer)")
  let confirming = prompt.choices == [.cancel, .recover]
  if !confirming && choice == .recover {
    try! Data().write(to: URL(fileURLWithPath: environment["REQUEST_MARKER"]!))
  }
  if confirming {
    try! Data().write(to: URL(fileURLWithPath: environment["CONFIRM_MARKER"]!))
    if environment["CHANGE_TO_UPDATE"] == "1" { gate.request(.update(version: "next")) {} }
  }
  return choice
}
gate.report = { emit("REPORT \($0)"); reported = true }
gate.onHoldChanged = { emit($0.map { "HOLD \($0)" } ?? "RELEASE") }
switch environment["MODE"] ?? "stale" {
case "update": gate.request(.update(version: "next")) { proceeded = true }
case "quit": gate.requestForQuit(version: "next", whenDrained: {}) { proceeded = $0 }
default: gate.request(.staleServer(from: "previous")) { proceeded = true }
}
let deadline = Date().addingTimeInterval(35)
while !proceeded && !reported && gate.phase != .waiting && Date() < deadline {
  RunLoop.main.run(until: Date().addingTimeInterval(0.02))
}
if environment["RECONSIDER"] == "1", gate.phase == .waiting {
  emit("MENU \(gate.pendingMenuTitle)")
  gate.reconsider()
  while !proceeded && !reported && gate.phase != .waiting && Date() < deadline {
    RunLoop.main.run(until: Date().addingTimeInterval(0.02))
  }
}
emit("PHASE \(gate.phase) MAINTENANCE \(Maintenance.activeNote() ?? "none")")
if proceeded && environment["ROLLBACK"] == "1" {
  var database: OpaquePointer?
  precondition(sqlite3_open(NaviConfig.dataURL.appendingPathComponent("navi.db").path, &database) == SQLITE_OK)
  precondition(sqlite3_exec(database, "create table failed_migration (id text)", nil, nil, nil) == SQLITE_OK)
  sqlite3_close(database)
  emit("RESTORED \(try RuntimeRecovery.restoreBeforeAdoption()!.path)")
}
if bundleLock >= 0 { close(bundleLock) }
exit(proceeded ? 0 : reported ? 1 : gate.phase == .waiting ? 2 : 3)
