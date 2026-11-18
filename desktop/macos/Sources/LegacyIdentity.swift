import AppKit
import os

/// 改名（ash → navi）的接班。Navi.app 的包标识是 dev.navi.mac，macOS 把它当成另一个应用：设置（defaults）、
/// 网页数据（WebKit 的 localStorage / cookie）、登录项、Application Support 下的那块地都按包标识分开放。
/// 已经装着 Ash.app（dev.ash.mac）的机器第一次打开 Navi 时，在这里把这几样接过来，再让旧 app 让位：
///  · 设置：旧 defaults 域里的每一项抄进新域（新域已有的不盖），改了名的几个键换成新名；
///  · 数据根：不搬。新的那块地还不存在、旧的在，就一直用旧的那块（`supportDirectory`）—— 服务、锁、窗口专用
///    端口（按数据根路径算）都还是原来那一份，页面的源不变，页面存在本机的设置也就跟着留下；
///  · 网页数据：WebKit 的网站数据按包标识存，新的还没有时整份复制过来（复制，不挪：旧的留着能退回去）；
///  · 登录项：旧的那条 LaunchAgent（dev.ash.server，指着 Ash.app 里的可执行文件）卸掉，开着的就换成自己的；
///  · 旧 app：退出它的窗口；等没有进程在用它的代码了（服务、MCP 都拿着包里的代码锁，见 install-app.sh），
///    把它移到废纸篓、原地留一个指向 Navi.app 的软链 —— CLI 的 MCP 登记、脚本里写死的 Ash.app 路径照样走得通，
///    也不会再有第二个 app 在同一个端口、同一份数据上起服务。旧服务由 UpdateGate 的 staleServer 那一档换掉，
///    换掉之前代码锁还被它拿着，这里隔一会儿再试。
///
/// 只有正式那份（dev.navi.mac）认旧身份；演练用的 app（别的 bundle id）和测试驱动（不是 bundle）都不碰日常
/// 那一份。会动别的 app 的几步（退出旧 app、换登录项、移走旧包）只在装进「应用程序」的那份上做：从构建目录
/// 里直接打开的那份随时会被删，不能让旧包的软链、登录项指到它身上。
///
/// 下面这些旧名是兼容值：批量改名时别把它们也换成 navi。
enum LegacyIdentity {
  static let bundleID = "dev.ash.mac"
  static let loginLabel = "dev.ash.server"
  static let appName = "Ash.app"
  /// 认旧身份的那个新身份。
  static let successor = "dev.navi.mac"
  /// 改了名的 defaults 键：旧名 → 新名。
  static let renamedDefaults = [
    "AshURL": "NaviURL",
    "AshDataDir": "NaviDataDir",
    "NSWindow Frame AshMainWindow": "NSWindow Frame NaviMainWindow",
  ]
  /// 数据根定在旧的那块地上之后记一笔：以后哪个组件先建出了新的那块地，也不会悄悄换成一个空数据根。
  static let pinnedSupportKey = "DataRootFromAsh"
  private static let adoptedDefaultsKey = "AdoptedAshDefaults"
  private static let adoptedWebDataKey = "AdoptedAshWebData"
  static let logger = Logger(subsystem: successor, category: "legacy-identity")

  private static var isSuccessor: Bool { Bundle.main.bundleIdentifier == successor }

  // MARK: 设置

  /// 旧域抄进新域：新域已有的不盖，改了名的键换成新名。返回抄过来的键（新名）。
  @discardableResult
  static func adoptDefaults(_ legacy: [String: Any]?, into defaults: UserDefaults) -> [String] {
    guard !defaults.bool(forKey: adoptedDefaultsKey) else { return [] }
    var adopted: [String] = []
    for (key, value) in legacy ?? [:] {
      let name = renamedDefaults[key] ?? key
      guard defaults.object(forKey: name) == nil else { continue }
      defaults.set(value, forKey: name)
      adopted.append(name)
    }
    defaults.set(true, forKey: adoptedDefaultsKey)
    return adopted.sorted()
  }

  /// 进程一开始（读任何设置之前）调：正式那份才认旧域。`--start-server` 那一档也要，它读的是同一份设置。
  static func adoptDefaultsAtLaunch() {
    guard isSuccessor else { return }
    let adopted = adoptDefaults(UserDefaults.standard.persistentDomain(forName: bundleID), into: .standard)
    if !adopted.isEmpty { logger.notice("接过 \(bundleID, privacy: .public) 的设置：\(adopted.joined(separator: ", "), privacy: .public)") }
  }

  // MARK: 数据根

  /// app 自己那块地（`root` 是 Application Support）。正式那份在新的还不存在、旧的在时用旧的，并且记下来。
  static func supportDirectory(in root: URL, bundleID: String, defaults: UserDefaults = .standard) -> URL {
    let own = root.appendingPathComponent(bundleID, isDirectory: true)
    guard bundleID == successor else { return own }
    let legacy = root.appendingPathComponent(Self.bundleID, isDirectory: true)
    let fm = FileManager.default
    guard fm.fileExists(atPath: legacy.path) else { return own }
    if defaults.bool(forKey: pinnedSupportKey) { return legacy }
    guard !fm.fileExists(atPath: own.path) else { return own }
    defaults.set(true, forKey: pinnedSupportKey)
    return legacy
  }

  // MARK: 网页数据

  /// WebKit 的网站数据、cookie 按包标识存（`library` 是 ~/Library）。新的那份还没有时把旧的复制过来，
  /// 只做一次。必须在第一个 WKWebView 建出来之前调 —— 建出来它就有自己那份了。返回复制了的路径。
  @discardableResult
  static func adoptWebData(library: URL, from legacy: String, to current: String, defaults: UserDefaults) -> [String] {
    guard !defaults.bool(forKey: adoptedWebDataKey) else { return [] }
    let fm = FileManager.default
    var copied: [String] = []
    let pairs = [
      ("WebKit/\(legacy)", "WebKit/\(current)"),
      ("HTTPStorages/\(legacy)", "HTTPStorages/\(current)"),
      ("HTTPStorages/\(legacy).binarycookies", "HTTPStorages/\(current).binarycookies"),
    ]
    for (from, to) in pairs {
      let source = library.appendingPathComponent(from)
      let target = library.appendingPathComponent(to)
      guard fm.fileExists(atPath: source.path), !fm.fileExists(atPath: target.path) else { continue }
      do {
        try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.copyItem(at: source, to: target)
        copied.append(target.path)
      } catch {
        // 复制到一半：删掉半截，下次启动再来（标记不落）。页面这次按全新的样子开，不影响别的。
        try? fm.removeItem(at: target)
        logger.error("复制 \(source.path, privacy: .public) 没成：\(error.localizedDescription, privacy: .public)")
        return copied
      }
    }
    defaults.set(true, forKey: adoptedWebDataKey)
    return copied
  }

  // MARK: 启动时接班（窗口建出来之前调）

  /// 正式那份每次启动都调；接过的不再接，旧 app 还在用就排一个隔一会儿再试。
  static func adoptAtLaunch() {
    guard isSuccessor else { return }
    let installed = LoginService.isInstalledLocation
    if installed { quitLegacyApps(timeout: 8) }
    let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
    let copied = adoptWebData(library: library, from: bundleID, to: successor, defaults: .standard)
    if !copied.isEmpty { logger.notice("接过网页数据：\(copied.joined(separator: ", "), privacy: .public)") }
    guard installed else { return }
    adoptLoginItem()
    retireWhenIdle()
  }

  /// 退出旧 app 的窗口，等它退干净（最多 timeout 秒）；服务不跟着退，那由 UpdateGate 换。
  private static func quitLegacyApps(timeout: TimeInterval) {
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
    guard !running.isEmpty else { return }
    running.forEach { $0.terminate() }
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline && running.contains(where: { !$0.isTerminated }) {
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
  }

  /// 旧登录项卸掉；它原来开着就把自己的开上（用户关掉过的，抄过来的 LoginServiceConfigured 让它保持关着）。
  private static func adoptLoginItem() {
    let plist = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/LaunchAgents/\(loginLabel).plist")
    guard FileManager.default.fileExists(atPath: plist.path) else { return }
    LoginService.bootout(label: loginLabel)
    do {
      try FileManager.default.removeItem(at: plist)
      try LoginService.setEnabled(true)
      logger.notice("登录项从 \(loginLabel, privacy: .public) 换成了 \(LoginService.label, privacy: .public)")
    } catch {
      logger.error("换登录项没成：\(error.localizedDescription, privacy: .public)")
    }
  }

  // MARK: 旧 app 让位

  enum Retirement: Equatable {
    /// 移到废纸篓了，原地留了软链。
    case retired(trashedAt: String)
    /// 还有进程在用它的代码（说明是谁）。
    case busy(String)
    case failed(String)
  }

  private static var retryTimer: Timer?

  private static func retireWhenIdle() {
    let results = legacyBundles().map { retire($0, successor: Bundle.main.bundleURL) }
    for result in results { logger.notice("旧 app：\(String(describing: result), privacy: .public)") }
    guard results.contains(where: { if case .busy = $0 { return true } else { return false } }) else {
      retryTimer?.invalidate()
      retryTimer = nil
      return
    }
    guard retryTimer == nil else { return }
    retryTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { _ in retireWhenIdle() }
  }

  /// 机器上装着的旧 app：LaunchServices 认得的、加上两个「应用程序」目录里那个名字的，只认包标识对得上、
  /// 不是软链（软链就是上一次留下的，已经指向新 app）、不在废纸篓里的。
  static func legacyBundles() -> [URL] {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let guesses = [URL(fileURLWithPath: "/Applications/\(appName)"), home.appendingPathComponent("Applications/\(appName)")]
    var seen = Set<String>()
    return (NSWorkspace.shared.urlsForApplications(withBundleIdentifier: bundleID) + guesses).filter { url in
      let path = url.standardizedFileURL.path
      guard seen.insert(path).inserted, !path.contains("/.Trash/") else { return false }
      return isLegacyBundle(url)
    }
  }

  static func isLegacyBundle(_ url: URL) -> Bool {
    guard let values = try? url.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey]),
          values.isSymbolicLink != true, values.isDirectory == true else { return false }
    return Bundle(url: url)?.bundleIdentifier == bundleID
  }

  /// 没人在用就移到废纸篓、原地放一个指向 `successor` 的软链。判「有没有人在用」与 install-app.sh 同一套：
  /// 对包里的代码锁拿排他锁，拿到了就一直拿到挪完（这期间想起来的进程在锁上等，等到时包已经不在原处）；
  /// 没有代码锁的更早版本只能按命令行扫一遍。窗口进程不拿锁，单独认。
  static func retire(_ bundle: URL, successor: URL) -> Retirement {
    let fm = FileManager.default
    if let gui = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
      .first(where: { $0.bundleURL?.standardizedFileURL == bundle.standardizedFileURL && !$0.isTerminated }) {
      return .busy("旧 app 的窗口进程 \(gui.processIdentifier) 还没退")
    }
    let lock = bundle.appendingPathComponent("Contents/Resources/app/.in-use")
    var descriptor: Int32 = -1
    if fm.fileExists(atPath: lock.path) {
      descriptor = open(lock.path, O_RDONLY | O_CLOEXEC)
      guard descriptor >= 0 else { return .failed("打不开代码锁 \(lock.path)：\(String(cString: strerror(errno)))") }
      guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
        close(descriptor)
        return .busy("有进程拿着 \(lock.path)（旧版的服务或 MCP 还在跑）")
      }
    } else if let user = processRunning(inside: bundle) {
      return .busy("进程还在用旧 app 的代码：\(user)")
    }
    defer { if descriptor >= 0 { close(descriptor) } }
    do {
      var trashed: NSURL?
      try fm.trashItem(at: bundle, resultingItemURL: &trashed)
      try fm.createSymbolicLink(at: bundle, withDestinationURL: successor)
      return .retired(trashedAt: trashed?.path ?? "")
    } catch {
      return .failed(error.localizedDescription)
    }
  }

  /// 命令行里带着这个包路径的进程（没有代码锁的旧版只能这么认）。
  private static func processRunning(inside bundle: URL) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-axww", "-o", "pid=,command="]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return "（查不了进程表）" }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let needle = bundle.standardizedFileURL.path + "/"
    return String(decoding: data, as: UTF8.self).split(separator: "\n")
      .first { $0.contains(needle) }
      .map { $0.trimmingCharacters(in: .whitespaces) }
  }
}
