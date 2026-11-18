import AppKit

// scripts/test-macos-identity.mjs 的驱动：编进来的是真的 LegacyIdentity（Ash.app → Navi.app 的接班）。
// 每一种情形一个子命令，路径、defaults 域都由测试给（临时目录、带 pid 的临时域），碰不到日常那一份。
// 通过打一行 OK，失败打 FAIL 并以 1 退出。

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else {
    fputs("FAIL: \(message)\n", stderr)
    exit(1)
  }
}

let args = CommandLine.arguments
let mode = args[1]

/// 测试给的临时 defaults 域；先清空，免得上一次残留。
func scratchDefaults(_ name: String) -> UserDefaults {
  let defaults = UserDefaults(suiteName: name)!
  defaults.removePersistentDomain(forName: name)
  return defaults
}

switch mode {
case "defaults":
  let defaults = scratchDefaults(args[2])
  defaults.set("new-wins", forKey: "Existing")
  let legacy: [String: Any] = [
    "AshURL": "http://192.168.1.187:4317",
    "AshDataDir": "/Volumes/data/navi",
    "NSWindow Frame AshMainWindow": "0 0 1455 949 0 0 1512 949 ",
    "LoginServiceConfigured": true,
    "SULastCheckTime": Date(timeIntervalSince1970: 1_800_000_000),
    "HostMcpSetupDone": ["/tmp/a"],
    "Existing": "old-loses",
  ]
  let adopted = LegacyIdentity.adoptDefaults(legacy, into: defaults)
  require(adopted == ["HostMcpSetupDone", "LoginServiceConfigured", "NSWindow Frame NaviMainWindow", "NaviDataDir", "NaviURL", "SULastCheckTime"],
          "adopted \(adopted)")
  require(defaults.string(forKey: "NaviURL") == "http://192.168.1.187:4317", "AshURL → NaviURL")
  require(defaults.string(forKey: "NaviDataDir") == "/Volumes/data/navi", "AshDataDir → NaviDataDir")
  require(defaults.string(forKey: "NSWindow Frame NaviMainWindow") == "0 0 1455 949 0 0 1512 949 ", "window frame follows the renamed autosave name")
  require(defaults.object(forKey: "AshURL") == nil, "renamed keys are not copied under their old names")
  require(defaults.bool(forKey: "LoginServiceConfigured"), "the login item choice comes along")
  require(defaults.string(forKey: "Existing") == "new-wins", "what the new domain already has is not overwritten")
  // 只接一次：之后旧域里再改什么，都不会再抄过来盖掉用户在新 app 里的设置。
  require(LegacyIdentity.adoptDefaults(["AshURL": "http://elsewhere:4317", "Late": 1], into: defaults).isEmpty, "adopted only once")
  require(defaults.string(forKey: "NaviURL") == "http://192.168.1.187:4317" && defaults.object(forKey: "Late") == nil, "second pass changes nothing")
  require(scratchDefaults(args[2] + ".empty").dictionaryRepresentation()["NaviURL"] == nil, "scratch domain is clean")
  require(LegacyIdentity.adoptDefaults(nil, into: scratchDefaults(args[2] + ".empty")).isEmpty, "no legacy domain → nothing adopted")
  UserDefaults.standard.removePersistentDomain(forName: args[2])
  UserDefaults.standard.removePersistentDomain(forName: args[2] + ".empty")
  print("OK defaults")

case "support":
  let root = URL(fileURLWithPath: args[2], isDirectory: true)
  let fm = FileManager.default
  let own = root.appendingPathComponent("dev.navi.mac").path
  let legacy = root.appendingPathComponent("dev.ash.mac").path
  var defaults = scratchDefaults(args[3])
  func pick(_ id: String = "dev.navi.mac") -> String {
    LegacyIdentity.supportDirectory(in: root, bundleID: id, defaults: defaults).path
  }
  require(pick() == own, "fresh machine → the new place")
  try! fm.createDirectory(atPath: legacy, withIntermediateDirectories: true)
  require(pick("dev.navi.mac.rehearsal") == root.appendingPathComponent("dev.navi.mac.rehearsal").path, "rehearsal builds never adopt the daily data")
  require(pick() == legacy, "upgraded machine → keep using the Ash data root in place")
  try! fm.createDirectory(atPath: own, withIntermediateDirectories: true)
  require(pick() == legacy, "pinned: something creating the new directory later does not switch to an empty data root")
  defaults = scratchDefaults(args[3] + ".fresh")
  require(pick() == own, "both exist and nothing was pinned (Navi already ran there) → the new place")
  UserDefaults.standard.removePersistentDomain(forName: args[3])
  UserDefaults.standard.removePersistentDomain(forName: args[3] + ".fresh")
  print("OK support")

case "webdata":
  let library = URL(fileURLWithPath: args[2], isDirectory: true)
  let defaults = scratchDefaults(args[3])
  let fm = FileManager.default
  let path = { (rel: String) in library.appendingPathComponent(rel).path }
  let read = { (rel: String) in (try? String(contentsOfFile: path(rel), encoding: .utf8)) ?? "<missing>" }
  // 第一次：HTTPStorages 写不进去 → 抛错；放上去的只有完整的 WebKit 那一份，暂存的半截不留，不记已接。
  try! fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: path("HTTPStorages"))
  var failed = false
  do { try LegacyIdentity.adoptWebData(library: library, from: "old.id", to: "new.id", defaults: defaults) } catch { failed = true }
  try! fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path("HTTPStorages"))
  require(failed, "a failed copy is reported")
  let settled = { LegacyIdentity.webDataSettled(library: library, current: "new.id", defaults: defaults) }
  require(!settled(), "not marked adopted after a failure")
  require(read("WebKit/new.id/WebsiteData/LocalStorage/origin.sqlite3") == "local-storage", "WebKit data copied")
  require(!fm.fileExists(atPath: path("HTTPStorages/new.id")), "no half copy left behind")
  require(try! fm.contentsOfDirectory(atPath: path("HTTPStorages")).allSatisfy { !$0.contains(".adopting") }, "no staging left behind")
  // 上一次拷到一半进程没了：它自己那个暂存位置里留着半截。这一次清掉重拷，放上去的是完整的。
  try! fm.createDirectory(atPath: path("HTTPStorages/.new.id.adopting-99999/half"), withIntermediateDirectories: true)
  let copied = try! LegacyIdentity.adoptWebData(library: library, from: "old.id", to: "new.id", defaults: defaults)
  require(copied == [path("HTTPStorages/new.id"), path("HTTPStorages/new.id.binarycookies")], "retry copied \(copied)")
  require(read("HTTPStorages/new.id/httpstorages.sqlite") == "cookies", "cookie store copied")
  require(!fm.fileExists(atPath: path("HTTPStorages/new.id/half")) && !fm.fileExists(atPath: path("HTTPStorages/.new.id.adopting-99999")), "stale staging cleared")
  require(read("HTTPStorages/new.id.binarycookies") == "binary-cookies", "binary cookies copied")
  require(read("WebKit/old.id/WebsiteData/LocalStorage/origin.sqlite3") == "local-storage", "copied, not moved: the old data is still there")
  require(settled(), "marked adopted once everything is in place")
  require(fm.fileExists(atPath: path("WebKit/.new.id.adopted-from-ash")), "the marker other processes trust is on disk")
  // 接过之后：新 app 自己的数据不会再被旧的盖掉。
  try! "changed-by-old-app".write(toFile: path("WebKit/old.id/WebsiteData/LocalStorage/origin.sqlite3"), atomically: true, encoding: .utf8)
  try! fm.removeItem(atPath: path("HTTPStorages/new.id.binarycookies"))
  require((try! LegacyIdentity.adoptWebData(library: library, from: "old.id", to: "new.id", defaults: defaults)).isEmpty, "adopted only once")
  require(read("WebKit/new.id/WebsiteData/LocalStorage/origin.sqlite3") == "local-storage", "new data untouched")
  UserDefaults.standard.removePersistentDomain(forName: args[3])
  print("OK webdata")

case "gate":
  // 建窗口之前那一道：旧 app 不肯退、复制失败都挡着（返回原因、不记已接、什么都不复制）；没有可接的直接放行。
  let library = URL(fileURLWithPath: args[2], isDirectory: true)
  let fm = FileManager.default
  let path = { (rel: String) in library.appendingPathComponent(rel).path }
  var defaults = scratchDefaults(args[3])
  var asked = 0
  require(LegacyIdentity.prepareWebData(library: library, from: "absent.id", to: "gate.id", defaults: defaults,
                                        quitLegacy: { asked += 1; return false }) == nil, "nothing to adopt → open")
  require(asked == 0 && LegacyIdentity.webDataSettled(library: library, current: "gate.id", defaults: defaults), "nothing to adopt → never asks the old app, settled")
  try! fm.removeItem(atPath: path("WebKit/.gate.id.adopted-from-ash"))
  defaults = scratchDefaults(args[3] + ".busy")
  let busy = LegacyIdentity.prepareWebData(library: library, from: "old.id", to: "gate.id", defaults: defaults, quitLegacy: { false })
  require(busy?.contains("Ash 还开着") == true, "old app still running → blocked: \(busy ?? "nil")")
  let gateSettled = { LegacyIdentity.webDataSettled(library: library, current: "gate.id", defaults: defaults) }
  require(!gateSettled() && !fm.fileExists(atPath: path("WebKit/gate.id")), "nothing copied while it runs")
  // 旧数据读不出来（比如权限、坏盘）：复制失败。
  try! fm.setAttributes([.posixPermissions: 0o000], ofItemAtPath: path("WebKit/old.id/WebsiteData"))
  let failed = LegacyIdentity.prepareWebData(library: library, from: "old.id", to: "gate.id", defaults: defaults, quitLegacy: { true })
  try! fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path("WebKit/old.id/WebsiteData"))
  require(failed?.contains("没成") == true && !gateSettled(), "copy failure → blocked: \(failed ?? "nil")")
  require(LegacyIdentity.prepareWebData(library: library, from: "old.id", to: "gate.id", defaults: defaults, quitLegacy: { true }) == nil, "retry → open")
  require(fm.fileExists(atPath: path("WebKit/gate.id")) && gateSettled(), "copied and settled")
  defaults = scratchDefaults(args[3] + ".skip")
  try! LegacyIdentity.settleWebData(library: library, current: "gate.skip", defaults: defaults)
  require(LegacyIdentity.prepareWebData(library: library, from: "old.id", to: "gate.skip", defaults: defaults, quitLegacy: { false }) == nil,
          "the user chose to skip → open without copying")
  require(!fm.fileExists(atPath: path("WebKit/gate.skip")), "skipping copies nothing")
  for suffix in ["", ".busy", ".skip"] { UserDefaults.standard.removePersistentDomain(forName: args[3] + suffix) }
  print("OK gate")

case "race":
  // 参数：library 旧 id 新 id defaults 域。几份同时跑的 Navi 之一：走真的 prepareWebData，返回时（这一份要建窗口了）
  // 报一下目标里有几个文件、这一份复制了没有。
  let library = URL(fileURLWithPath: args[2], isDirectory: true)
  let defaults = UserDefaults(suiteName: args[5])!
  let blocked = LegacyIdentity.prepareWebData(library: library, from: args[3], to: args[4], defaults: defaults, quitLegacy: { true })
  let target = library.appendingPathComponent("WebKit/\(args[4])").path
  let files = FileManager.default.enumerator(atPath: target)?.allObjects.count ?? -1
  print("OPEN blocked=\(blocked ?? "nil") files=\(files)")

case "login":
  // 参数：旧登录项 plist 路径（临时的）、defaults 域。LoginService 用替身：记开了几次，不碰 launchctl。
  let item = URL(fileURLWithPath: args[2])
  let fm = FileManager.default
  var defaults = scratchDefaults(args[3])
  var enables = 0
  let enable: () throws -> Void = { enables += 1 }
  let quiet: (String) -> Void = { _ in }
  // 旧登录项删不掉（Finder 里「已锁定」）：新的开上了，旧的留着。
  fm.createFile(atPath: item.path, contents: Data("<plist/>".utf8))
  try! fm.setAttributes([.immutable: true], ofItemAtPath: item.path)
  LegacyIdentity.adoptLoginItem(item, defaults: defaults, enable: enable, bootout: quiet)
  require(enables == 1 && fm.fileExists(atPath: item.path), "enabled once, the locked old item stays")
  // 用户在菜单里关掉：记下决定；旧的删不掉要报出来，不能报个关掉了。
  var threw = false
  do { try LegacyIdentity.userTurnedLoginOff(item, defaults: defaults, bootout: quiet) } catch { threw = true }
  require(threw, "turning it off says the old item could not be removed")
  // 后台下一轮：只清理，不替用户再打开。
  LegacyIdentity.adoptLoginItem(item, defaults: defaults, enable: enable, bootout: quiet)
  require(enables == 1, "a retry never turns the user's choice back on")
  try! fm.setAttributes([.immutable: false], ofItemAtPath: item.path)
  LegacyIdentity.adoptLoginItem(item, defaults: defaults, enable: enable, bootout: quiet)
  require(enables == 1 && !fm.fileExists(atPath: item.path), "once removable, the old item is cleaned up and nothing is turned on")
  // 新的那条装不上：还没有决定，旧的留着，下一轮再开。
  defaults = scratchDefaults(args[3] + ".retry")
  fm.createFile(atPath: item.path, contents: Data("<plist/>".utf8))
  LegacyIdentity.adoptLoginItem(item, defaults: defaults, enable: { throw CocoaError(.fileWriteUnknown) }, bootout: quiet)
  require(fm.fileExists(atPath: item.path), "a failed enable keeps the old item")
  LegacyIdentity.adoptLoginItem(item, defaults: defaults, enable: enable, bootout: quiet)
  require(enables == 2 && !fm.fileExists(atPath: item.path), "the next round enables and cleans up")
  for suffix in ["", ".retry"] { UserDefaults.standard.removePersistentDomain(forName: args[3] + suffix) }
  print("OK login")

case "lock-wait":
  // 参数：library 旧 id 新 id defaults 域。迁移锁被别人一直拿着：等满时限就交出原因，不无限僵住。
  LegacyIdentity.lockTimeout = 1
  let started = Date()
  let blocked = LegacyIdentity.prepareWebData(library: URL(fileURLWithPath: args[2], isDirectory: true), from: args[3], to: args[4],
                                              defaults: scratchDefaults(args[5]), quitLegacy: { true })
  require(blocked?.contains("另一份 Navi") == true, "blocked: \(blocked ?? "nil")")
  require(Date().timeIntervalSince(started) < 10, "gave up after the time limit")
  // 这时用户点「不接了」：锁还在别人手里，什么都不记，窗口照样不开（那一份还会接着往同一个位置放数据）。
  let library = URL(fileURLWithPath: args[2], isDirectory: true)
  let skipDefaults = scratchDefaults(args[5] + ".skip")
  let refused = LegacyIdentity.skipWebData(library: library, current: args[4], defaults: skipDefaults)
  require(refused?.contains("另一份 Navi") == true, "skip without the lock is refused: \(refused ?? "nil")")
  require(!LegacyIdentity.webDataSettled(library: library, current: args[4], defaults: skipDefaults), "nothing recorded")
  require(LegacyIdentity.prepareWebData(library: library, from: args[3], to: args[4], defaults: skipDefaults, quitLegacy: { true }) != nil,
          "the gate still blocks")
  // 测试接着放掉锁（见 test-macos-identity.mjs），再来一次就记得下。
  print("WAITING")
  fflush(stdout)
  _ = readLine()
  require(LegacyIdentity.skipWebData(library: library, current: args[4], defaults: skipDefaults) == nil, "skip with the lock is recorded")
  require(LegacyIdentity.webDataSettled(library: library, current: args[4], defaults: skipDefaults), "settled once skipped under the lock")
  for suffix in ["", ".skip"] { UserDefaults.standard.removePersistentDomain(forName: args[5] + suffix) }
  print("OK lock-wait")

case "is-legacy":
  // 参数：路径 期望(yes/no)
  require(LegacyIdentity.isLegacyBundle(URL(fileURLWithPath: args[2])) == (args[3] == "yes"), "isLegacyBundle(\(args[2])) should be \(args[3])")
  print("OK is-legacy")

case "retire", "retire-link-fails":
  // 参数：旧包路径 新包路径 bundle-users.sh 旧登录项 plist 路径；打出结果给测试判。retire-link-fails：原地放软链那一步失败。
  // 登录项路径一定由测试给：默认那一份是这台机器上真的 ~/Library/LaunchAgents/dev.ash.server.plist。
  let failLink: (URL, URL) throws -> Void = { _, _ in throw CocoaError(.fileWriteNoPermission) }
  let (bundle, successor, users, login) = (URL(fileURLWithPath: args[2]), URL(fileURLWithPath: args[3]), URL(fileURLWithPath: args[4]), URL(fileURLWithPath: args[5]))
  let result = mode == "retire"
    ? LegacyIdentity.retire(bundle, successor: successor, usersScript: users, loginItem: login)
    : LegacyIdentity.retire(bundle, successor: successor, usersScript: users, loginItem: login, placeLink: failLink)
  switch result {
  case .retired(let trashedAt): print("RETIRED \(trashedAt)")
  case .busy(let why): print("BUSY \(why)")
  case .failed(let why): print("FAILED \(why)")
  }

default:
  fputs("unknown mode \(mode)\n", stderr)
  exit(2)
}
