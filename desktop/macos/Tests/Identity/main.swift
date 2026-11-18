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
  // 第一次：HTTPStorages 写不进去 → 复制到一半，半截删掉、不记已接，下次再来。
  try! fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: path("HTTPStorages"))
  var copied = LegacyIdentity.adoptWebData(library: library, from: "old.id", to: "new.id", defaults: defaults)
  try! fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path("HTTPStorages"))
  require(copied == [path("WebKit/new.id")], "first pass copied \(copied)")
  require(!fm.fileExists(atPath: path("HTTPStorages/new.id")), "no half copy left behind")
  require(read("WebKit/new.id/WebsiteData/LocalStorage/origin.sqlite3") == "local-storage", "WebKit data copied")
  copied = LegacyIdentity.adoptWebData(library: library, from: "old.id", to: "new.id", defaults: defaults)
  require(copied == [path("HTTPStorages/new.id"), path("HTTPStorages/new.id.binarycookies")], "retry copied \(copied)")
  require(read("HTTPStorages/new.id/httpstorages.sqlite") == "cookies", "cookie store copied")
  require(read("HTTPStorages/new.id.binarycookies") == "binary-cookies", "binary cookies copied")
  require(read("WebKit/old.id/WebsiteData/LocalStorage/origin.sqlite3") == "local-storage", "copied, not moved: the old data is still there")
  // 接过之后：新 app 自己的数据不会再被旧的盖掉。
  try! "changed-by-old-app".write(toFile: path("WebKit/old.id/WebsiteData/LocalStorage/origin.sqlite3"), atomically: true, encoding: .utf8)
  try! fm.removeItem(atPath: path("HTTPStorages/new.id.binarycookies"))
  require(LegacyIdentity.adoptWebData(library: library, from: "old.id", to: "new.id", defaults: defaults).isEmpty, "adopted only once")
  require(read("WebKit/new.id/WebsiteData/LocalStorage/origin.sqlite3") == "local-storage", "new data untouched")
  UserDefaults.standard.removePersistentDomain(forName: args[3])
  print("OK webdata")

case "is-legacy":
  // 参数：路径 期望(yes/no)
  require(LegacyIdentity.isLegacyBundle(URL(fileURLWithPath: args[2])) == (args[3] == "yes"), "isLegacyBundle(\(args[2])) should be \(args[3])")
  print("OK is-legacy")

case "retire":
  // 参数：旧包路径 新包路径；打出结果给测试判。
  let result = LegacyIdentity.retire(URL(fileURLWithPath: args[2]), successor: URL(fileURLWithPath: args[3]))
  switch result {
  case .retired(let trashedAt): print("RETIRED \(trashedAt)")
  case .busy(let why): print("BUSY \(why)")
  case .failed(let why): print("FAILED \(why)")
  }

default:
  fputs("unknown mode \(mode)\n", stderr)
  exit(2)
}
