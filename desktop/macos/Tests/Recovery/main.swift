import AppKit
import SQLite3

let environment = ProcessInfo.processInfo.environment
var answers = (environment["ANSWERS"] ?? "").split(separator: ",").map(String.init)
let gate = UpdateGate.shared
gate.shutdownTimeout = 0.4
gate.lockTimeout = 0.4
gate.pollInterval = environment["VERIFY_HANDOVER_WAIT"] == "1" || environment["AUTO_SWITCH"] == "1" ? 0.05 : 60
var proceeded = false
var reported = false
var promptCount = 0
var heldLock: ServerStartLock?
var bundleLock: Int32 = -1

func emit(_ value: String) { print(value); fflush(stdout) }

if environment["MODE"]?.hasPrefix("ui") == true {
  _ = NSApplication.shared
  NSApp.setActivationPolicy(.regular)
  NSApp.finishLaunching()
  if environment["MODE"] == "ui-rollback" {
    gate.pauseAfterRecovery(from: "previous", reason: "隔离演练：新版迁移进程退出，旧服务已恢复。")
    emit("RECOVERY_UI_DISMISSED \(gate.phase)")
    exit(gate.phase == .blocked ? 0 : 1)
  }
  let choice = UpdateGate.runAlert(UpdateGate.Prompt(title: "打断任务并切换服务？",
    detail: "任务、模型请求和 MCP 交卷可能中断。新版启动失败且未开始接管时自动恢复旧服务。",
    buttons: ["取消", "打断任务并切换"], choices: [.cancel, .recover],
    affectedTasks: (1...20).map { "· 隔离任务 \($0) —— 强制切换不保证接管" }))
  emit("UI_CHOICE \(choice)")
  exit(choice == .cancel ? 0 : 1)
}

if environment["MODE"]?.hasPrefix("paused-") == true {
  let outcome = ServerLauncher.shared.ensureRunningSync(timeout: 5)
  emit("PAUSED_OUTCOME \(outcome)")
  guard case .ready = outcome else { exit(1) }
  let pause = try RuntimeRecovery.paused()!
  guard case .navi(let instance) = NaviHealth.probeSync() else { fatalError("paused service not running") }
  precondition(NaviHealth.samePath(instance.codeDir!, pause.previous))
  precondition(ServerRecord.read()?.bundleVersion == pause.version)
  emit("PAUSED_SERVICE \(instance.codeDir!) VERSION \(pause.version)")
  if environment["MODE"] == "paused-gui" {
    let retry = environment["RETRY_PAUSED_TARGET"]
    gate.report = { emit("PERSISTED_NOTICE \($0)") }
    gate.request(.staleServer(from: pause.version)) {
      precondition(retry != nil, "automatic retry escaped durable pause")
      proceeded = true
    }
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    precondition(gate.phase == .blocked && gate.hasPending)
    emit("PERSISTED_GATE blocked")
    if let retry {
      let deadline = Date().addingTimeInterval(15)
      gate.pollInterval = 0.05
      gate.report = { emit("RETRY_REPORT \($0)"); reported = true }
      gate.onHoldChanged = { note in
        guard note != nil else { return }
        precondition(RuntimeStore.contains(NaviConfig.targetRuntimeURL.path))
        precondition(NaviHealth.samePath(RuntimeStore.root.appendingPathComponent("current").path, pause.previous))
        precondition(FileManager.default.fileExists(atPath: RuntimeRecovery.pauseURL.path))
        emit("STAGED_WITHOUT_ACTIVATION")
      }
      gate.ask = { prompt in
        emit("RETRY_PROMPT \(prompt.detail)")
        if retry == "failure" {
          precondition(prompt.detail.contains("新版运行时准备失败"))
        } else {
          precondition(retry == "wait" && !prompt.detail.contains("新版接管协议无法核实"))
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            try! FileManager.default.removeItem(at: NaviConfig.dataURL.appendingPathComponent(".recovery-retry-busy"))
          }
        }
        return .wait
      }
      gate.reconsider()
      while !proceeded && !reported && Date() < deadline {
        if retry == "failure", gate.phase == .waiting { break }
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
      }
      if retry == "failure" {
        precondition(!proceeded && !reported && gate.phase == .waiting && !gate.isHolding)
        precondition(NaviHealth.samePath(RuntimeStore.root.appendingPathComponent("current").path, pause.previous))
        let savedPause = try RuntimeRecovery.paused()
        precondition(savedPause != nil)
        emit("STAGING_REFUSED_OLD_PRESERVED")
        exit(2)
      }
      precondition(proceeded && !reported)
      let savedPause = try RuntimeRecovery.paused()
      precondition(savedPause == nil)
      emit("PAUSED_RETRY_OUTCOME \(ServerLauncher.shared.ensureRunningSync(timeout: 5))")
      guard case .navi(let next) = NaviHealth.probeSync() else { fatalError("target did not start") }
      precondition(NaviHealth.samePath(next.codeDir!, NaviConfig.targetRuntimeURL.path))
      precondition(ServerRecord.staleVersion(servingPID: next.pid) == nil)
      emit("PAUSED_RETRY_SERVICE \(next.codeDir!)")
    }
  }
  exit(0)
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
  case "now": choice = .now
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
while !proceeded && !reported && (gate.phase != .waiting || environment["WAIT_FOR_SWITCH"] == "1") && Date() < deadline {
  RunLoop.main.run(until: Date().addingTimeInterval(0.02))
}
if environment["VERIFY_HANDOVER_WAIT"] == "1" {
  precondition(gate.phase == .waiting && !proceeded && !gate.isHolding)
  RunLoop.main.run(until: Date().addingTimeInterval(0.2))
  while gate.phase != .waiting && !proceeded && !reported && Date() < deadline {
    RunLoop.main.run(until: Date().addingTimeInterval(0.02))
  }
  precondition(gate.phase == .waiting && !proceeded && !gate.isHolding && promptCount == 0 && !reported)
  emit("HANDOVER_WAIT")
}
if environment["MANUAL_SWITCH"] == "1", gate.phase == .waiting && promptCount == 0 {
  gate.reconsider()
  while !proceeded && !reported && gate.phase != .waiting && Date() < deadline {
    RunLoop.main.run(until: Date().addingTimeInterval(0.02))
  }
}
if environment["RECONSIDER"] == "1", gate.phase == .waiting || gate.phase == .blocked {
  emit("MENU \(gate.pendingMenuTitle)")
  reported = false
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
  let savedPause = try RuntimeRecovery.paused()
  precondition(savedPause != nil)
  if environment["HEADLESS_RECOVERY"] == "1" { emit("HEADLESS_PAUSE_SAVED"); exit(0) }
  while !reported && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
  precondition(reported && gate.phase == .blocked && gate.hasPending)
  RunLoop.main.run(until: Date().addingTimeInterval(0.2))
  precondition(gate.phase == .blocked)
  emit("RECOVERY_NOTICE_AND_PAUSE")
  reported = false
  if environment["RESTART_PAUSED"] == "1" {
    guard case .navi(let instance) = NaviHealth.probeSync(), let pid = instance.pid else { fatalError("old service not running") }
    guard case .stopped = ServerShutdown.stop(expecting: .ours(pid: pid), timeout: 5) else { fatalError("old service did not stop") }
    emit("PAUSED_RESTART \(ServerLauncher.shared.ensureRunningSync(timeout: 5))")
    guard case .navi(let restarted) = NaviHealth.probeSync() else { fatalError("old service did not restart") }
    precondition(NaviHealth.samePath(restarted.codeDir!, savedPause!.previous))
    precondition(ServerRecord.read()?.bundleVersion == savedPause!.version)
  }
  if environment["RETRY_AFTER_ROLLBACK"] == "1" || environment["NORMAL_RETRY_AFTER_ROLLBACK"] == "1" {
    let normal = environment["NORMAL_RETRY_AFTER_ROLLBACK"] == "1"
    if normal {
      try Data().write(to: NaviConfig.dataURL.appendingPathComponent(".recovery-retry-clear"))
      let expected = RuntimeHandover.compatibility()!
      let next = try Data(contentsOf: NaviConfig.targetRuntimeURL.appendingPathComponent(".handover.json"))
      let metadata = try JSONSerialization.jsonObject(with: next) as! [String: Any]
      precondition(expected["schema"] as? String == metadata["schema"] as? String)
      try next.write(to: NaviConfig.dataURL.appendingPathComponent(".recovery-retry-target.json"))
    }
    proceeded = false
    gate.request(.staleServer(from: "previous")) { proceeded = true }
    gate.reconsider()
    while !proceeded && !reported && gate.phase != .waiting && Date() < deadline {
      RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    precondition(proceeded && !reported)
    let record = try JSONDecoder().decode(RuntimeRecovery.Record.self, from: Data(contentsOf: RuntimeRecovery.url))
    precondition(NaviHealth.samePath(record.next, RuntimeStore.destination!.path))
    let remainingPause = try RuntimeRecovery.paused()
    precondition(remainingPause == nil)
    emit("RETRY_TARGET \(NaviHealth.realPath(NaviConfig.runtimeURL.path))")
    if normal {
      emit("RETRY_OUTCOME \(ServerLauncher.shared.ensureRunningSync(timeout: 5))")
      guard case .navi(let instance) = NaviHealth.probeSync() else { fatalError("retry did not start service") }
      precondition(NaviHealth.samePath(instance.codeDir!, NaviConfig.targetRuntimeURL.path))
      precondition(ServerRecord.staleVersion(servingPID: instance.pid) == nil)
      precondition(!FileManager.default.fileExists(atPath: RuntimeRecovery.url.path))
      emit("RETRY_SERVICE \(instance.codeDir!)")
    }
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
