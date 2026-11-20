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

if environment["MODE"] == "ui" {
  _ = NSApplication.shared
  NSApp.setActivationPolicy(.regular)
  NSApp.finishLaunching()
  let choice = UpdateGate.runAlert(UpdateGate.Prompt(title: "打断任务并切换服务？",
    detail: "任务、模型请求和 MCP 交卷可能中断。新版启动失败且未开始接管时自动恢复旧服务。",
    buttons: ["取消", "打断任务并切换"], choices: [.cancel, .recover],
    affectedTasks: (1...20).map { "· 隔离任务 \($0) —— 强制切换不保证接管" }))
  emit("UI_CHOICE \(choice)")
  exit(choice == .cancel ? 0 : 1)
}

try RuntimeStore.prepare()
if environment["MISSING_NEXT"] == "1" { try FileManager.default.removeItem(at: RuntimeStore.destination!) }

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
  default: choice = .cancel
  }
  precondition(prompt.choices.contains(choice), "Answer not offered: \(answer)")
  let confirming = prompt.choices == [.cancel, .recover]
  if !confirming && choice == .recover {
    try! Data().write(to: URL(fileURLWithPath: environment["REQUEST_MARKER"]!))
  }
  if confirming {
    try! Data().write(to: URL(fileURLWithPath: environment["CONFIRM_MARKER"]!))
    if environment["CHANGE_TO_UPDATE"] == "1" { gate.request(.update(version: "next")) { proceeded = true } }
  }
  return choice
}
gate.report = { emit("REPORT \($0)"); reported = true }
var pendingInstall = false
var installFinished = false
gate.onHoldChanged = { note in
  emit(note.map { "HOLD \($0)" } ?? "RELEASE")
  guard note != nil, !pendingInstall else { return }
  if environment["UPDATE_DURING_PREPARE"] == "1" {
    pendingInstall = true
    gate.request(.update(version: "next")) { emit("INSTALL_ALLOWED"); installFinished = true }
  }
  if environment["QUIT_DURING_PREPARE"] == "1" {
    pendingInstall = true
    gate.requestForQuit(version: "next", whenDrained: {}) { emit("QUIT_ALLOWED \($0)"); installFinished = true }
  }
}
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
while pendingInstall && !installFinished && !reported && Date() < deadline {
  RunLoop.main.run(until: Date().addingTimeInterval(0.02))
}
emit("PHASE \(gate.phase) MAINTENANCE \(Maintenance.activeNote() ?? "none")")
if proceeded && environment["START_FAILED_MIGRATION"] == "1" {
  emit("OUTCOME \(ServerLauncher.shared.ensureRunningSync(timeout: 5))")
  if case .navi(let instance) = NaviHealth.probeSync() { emit("RESTORED_SERVICE \(instance.codeDir ?? "none")") }
  if environment["RETRY_AFTER_ROLLBACK"] == "1" {
    proceeded = false
    gate.request(.staleServer(from: "previous")) { proceeded = true }
    while !proceeded && !reported && gate.phase != .waiting && Date() < deadline {
      RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    precondition(proceeded && !reported)
    let record = try JSONDecoder().decode(RuntimeRecovery.Record.self, from: Data(contentsOf: RuntimeRecovery.url))
    precondition(NaviHealth.samePath(record.next, RuntimeStore.destination!.path))
    emit("RETRY_TARGET \(NaviHealth.realPath(NaviConfig.runtimeURL.path))")
  }
}
if proceeded && (environment["ROLLBACK"] == "1" || environment["ADOPTED_ROLLBACK"] == "1") {
  var database: OpaquePointer?
  precondition(sqlite3_open(NaviConfig.dataURL.appendingPathComponent("navi.db").path, &database) == SQLITE_OK)
  precondition(sqlite3_exec(database, "create table failed_migration (id text)", nil, nil, nil) == SQLITE_OK)
  sqlite3_close(database)
  if environment["ADOPTED_ROLLBACK"] == "1" {
    var record = try JSONDecoder().decode(RuntimeRecovery.Record.self, from: Data(contentsOf: RuntimeRecovery.url))
    record.adopting = true
    try JSONEncoder().encode(record).write(to: RuntimeRecovery.url, options: .atomic)
    do { _ = try RuntimeRecovery.restoreBeforeAdoption(); fatalError("restored adopted data") }
    catch { emit("REFUSED_ADOPTED \(error)") }
  } else { emit("RESTORED \(try RuntimeRecovery.restoreBeforeAdoption()!.path)") }
}
if bundleLock >= 0 { close(bundleLock) }
exit(reported ? 1 : proceeded ? 0 : gate.phase == .waiting ? 2 : 3)
