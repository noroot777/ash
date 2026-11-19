import AppKit
import os

/// 改名（ash → navi）的接班。Navi.app 的包标识是 dev.navi.mac，macOS 把它当成另一个应用：设置（defaults）、
/// 网页数据（WebKit 的 localStorage / cookie）、登录项、Application Support 下的那块地都按包标识分开放。
/// 已经装着 Ash.app（dev.ash.mac）的机器第一次打开 Navi 时，在这里把这几样接过来，再让旧 app 让位：
///  · 设置：旧 defaults 域里的每一项抄进新域（新域已有的不盖），改了名的几个键换成新名；
///  · 数据根：不搬。新的那块地还不存在、旧的在，就一直用旧的那块（`supportDirectory`）—— 服务、锁、窗口专用
///    端口（按数据根路径算）都还是原来那一份，页面的源不变，页面存在本机的设置也就跟着留下；
///  · 网页数据：WebKit 的网站数据按包标识存。先请旧 app 退出，再整份复制过来（复制，不挪：旧的留着能退回去）；
///    接完之前不建窗口 —— 旧 app 不肯退、复制失败时由 AppDelegate 问用户重试、不接了还是退出；
///  · 登录项：旧的那条 LaunchAgent（dev.ash.server，指着 Ash.app 里的可执行文件）开着就先装好自己的，再卸旧的；
///  · 旧 app：等它的窗口退了、也没有进程在用它的代码了（与 install-app.sh 同一份判据 bundle-users.sh），
///    把它移到废纸篓、原地留一个指向 Navi.app 的软链 —— CLI 的 MCP 登记、脚本里写死的 Ash.app 路径照样走得通，
///    也不会再有第二个 app 在同一个端口、同一份数据上起服务。旧服务由 UpdateGate 的 staleServer 那一档换掉，
///    换掉之前它还在用旧包，这里在后台隔一会儿再试。
///
/// 只有正式那份（dev.navi.mac）认旧身份；演练用的 app（别的 bundle id）和测试驱动（不是 bundle）都不碰日常
/// 那一份。换登录项、移走旧包只在装进「应用程序」的那份上做：从构建目录里直接打开的那份随时会被删，不能让
/// 旧包的软链、登录项指到它身上。接网页数据两边都做，所以两边都要先请旧 app 退出。
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

  // MARK: 环境变量

  /// 环境变量的旧前缀：改名前的启动配置（`ASH_URL`、`ASH_DATA_DIR` 这类，构建测试用的那几个口子也一样）照样认。
  /// 口径同 scripts/env.mjs：新名优先，新名没设（或是空串）才退到旧名。
  static let envPrefix = "ASH_"

  /// 一个 `NAVI_` 开头的变量的值：新名优先，退到旧名；空串当没设。
  static func environment(_ name: String, in env: [String: String]) -> String? {
    envGenerations(name).lazy.compactMap { env[$0] }.first { !$0.isEmpty }
  }

  /// 指向数据的变量（连哪台、数据根）：两代都设了、值又不一样，就说不清该用哪一份 —— 返回冲突说明，调用方
  /// 拒绝打开，不替用户挑（挑错了就是开着另一份数据、原来的任务「不见了」）。同 scripts/env.mjs 的 readStorageEnv。
  static func environmentConflict(_ name: String, in env: [String: String]) -> String? {
    let set = envGenerations(name).compactMap { key -> (String, String)? in
      guard let value = env[key]?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
      return (key, value)
    }
    guard let first = set.first, let other = set.dropFirst().first(where: { $0.1 != first.1 }) else { return nil }
    return "\(first.0)=\(first.1) 和 \(other.0)=\(other.1) 同时设了、指向不同的地方，不知道该用哪一个：擦掉其中一个再打开。"
  }

  private static func envGenerations(_ name: String) -> [String] {
    precondition(name.hasPrefix("NAVI_"), "环境变量名必须以 NAVI_ 开头：\(name)")
    return [name, envPrefix + name.dropFirst("NAVI_".count)]
  }

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

  /// 网页数据接完了，或者用户说了不接。**没走到这一步之前不能建 WKWebView**：它一建出来就在新身份下建好
  /// 自己那份目录，「目标在不在」从此分不清是接过来的还是它建的，旧的登录和草稿就再也接不回来了。
  ///
  /// 「接完了」除了记在 defaults 里，还落一个标记文件：同时开着两份 Navi 时，一份写的 defaults 另一份未必
  /// 马上看得到，锁里认的是文件。
  static func webDataSettled(library: URL, current: String, defaults: UserDefaults) -> Bool {
    defaults.bool(forKey: adoptedWebDataKey) || FileManager.default.fileExists(atPath: webDataMarker(library, current).path)
  }

  /// 用户选了「不接了」：之后照新的样子开。也在锁里记，免得另一份正在复制的 Navi 跟它交错。
  static func settleWebData(library: URL, current: String, defaults: UserDefaults) throws {
    try withAdoptionLock(library: library, current: current) { try commitWebData(library, current, defaults) }
  }

  /// AppDelegate 那个「不接了，直接打开」。返回 nil = 记下了、可以开窗口；否则是记不下的原因，窗口照样不开。
  ///
  /// 拿不到迁移锁（另一份 Navi 还在复制）就**什么都不记**：那一份还会接着往同一个位置放数据，这时开窗口，页面读到的
  /// 是只接了一半的旧数据，还会跟它交错。只有拿到锁、确认没人在复制了，才记「不接了」。
  static func skipWebData(library: URL? = nil, current: String = successor, defaults: UserDefaults = .standard) -> String? {
    do {
      try settleWebData(library: library ?? userLibrary, current: current, defaults: defaults)
      return nil
    } catch {
      logger.error("记不下「不接了」：\(error.localizedDescription, privacy: .public)")
      // 锁拿到了、只是标记文件落不下：defaults 那一笔已经在锁里记上了（commitWebData 先记它），照新的样子开。
      return webDataSettled(library: library ?? userLibrary, current: current, defaults: defaults) ? nil : error.localizedDescription
    }
  }

  private static var userLibrary: URL { FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0] }
  private static func webDataMarker(_ library: URL, _ current: String) -> URL {
    library.appendingPathComponent("WebKit/.\(current).adopted-from-ash")
  }

  /// 只在迁移锁里调。defaults 先记：标记文件落不下时，这一笔「锁里定下的已接」也不会丢。
  private static func commitWebData(_ library: URL, _ current: String, _ defaults: UserDefaults) throws {
    defaults.set(true, forKey: adoptedWebDataKey)
    try Data().write(to: webDataMarker(library, current), options: .atomic)
  }

  private static func webDataPairs(library: URL, from legacy: String, to current: String) -> [(URL, URL)] {
    [
      ("WebKit/\(legacy)", "WebKit/\(current)"),
      ("HTTPStorages/\(legacy)", "HTTPStorages/\(current)"),
      ("HTTPStorages/\(legacy).binarycookies", "HTTPStorages/\(current).binarycookies"),
    ].map { (library.appendingPathComponent($0.0), library.appendingPathComponent($0.1)) }
  }

  /// 等迁移锁最多等多久（测试里调短）。
  static var lockTimeout: TimeInterval = 30

  struct AdoptionError: LocalizedError {
    let errorDescription: String?
  }

  /// 整次接班（查已接、复制、放上去、记已接）同一时刻只有一个进程在做：同时开着的两份 Navi（构建目录里的、
  /// 「应用程序」里的、`open -n` 多开的）各自按路径判断，就会一份把另一份还没拷完的目录放上去、还记了已接。
  /// 另一份在锁上等，等到时已经接完，它也就不会在接完之前建窗口。
  ///
  /// 等锁有时限：持锁那一份卡住了（被挂起、在等什么）的时候，这一份不能没完没了地僵在启动上 —— 等满了就把原因
  /// 交给 AppDelegate 那个「重试 / 不接了 / 退出」的弹窗。
  private static func withAdoptionLock<T>(library: URL, current: String, timeout: TimeInterval = lockTimeout,
                                          _ body: () throws -> T) throws -> T {
    let directory = library.appendingPathComponent("WebKit", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let path = directory.appendingPathComponent(".\(current).adopting.lock").path
    let descriptor = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else {
      throw AdoptionError(errorDescription: "打不开迁移锁 \(path)：\(String(cString: strerror(errno)))")
    }
    defer { close(descriptor) }
    // 按开机以来的时间算，不按墙钟：系统时间被往回调也不会多等。
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
      guard errno == EWOULDBLOCK else {
        throw AdoptionError(errorDescription: "拿不到迁移锁 \(path)：\(String(cString: strerror(errno)))")
      }
      guard ProcessInfo.processInfo.systemUptime < deadline else {
        throw AdoptionError(errorDescription: "另一份 Navi 正在接 Ash 的网页数据，等了 \(Int(timeout)) 秒还没接完。等它接完再点「重试」，或者先把那一份退出。")
      }
      usleep(50_000)
    }
    return try body()
  }

  /// WebKit 的网站数据、cookie 按包标识存（`library` 是 ~/Library）。把旧的复制过来（复制，不挪：旧的留着能退回去）。
  /// 都在迁移锁里做：每一项拷到**这个进程自己**的暂存位置、拷完一次改名放上去，放上去的一定是自己拷完整的那一份；
  /// 目标已经在就是之前哪一次放上去的（只有持锁的进程会放，没接完之前也没人建 WKWebView），跳过。三项都放上去
  /// 才记「已接」。失败抛错：暂存的半截删掉、不记已接，下次再来。返回这一次复制了的路径。
  @discardableResult
  static func adoptWebData(library: URL, from legacy: String, to current: String, defaults: UserDefaults) throws -> [String] {
    try withAdoptionLock(library: library, current: current) {
      guard !webDataSettled(library: library, current: current, defaults: defaults) else { return [] }
      let fm = FileManager.default
      var copied: [String] = []
      for (source, target) in webDataPairs(library: library, from: legacy, to: current) {
        let parent = target.deletingLastPathComponent()
        let prefix = ".\(target.lastPathComponent).adopting"
        // 之前拷到一半进程没了留下的暂存：持锁的只有自己，别人的都是死的。
        for leftover in (try? fm.contentsOfDirectory(atPath: parent.path)) ?? [] where leftover.hasPrefix(prefix) && !leftover.hasSuffix(".lock") {
          try? fm.removeItem(at: parent.appendingPathComponent(leftover))
        }
        guard fm.fileExists(atPath: source.path), !fm.fileExists(atPath: target.path) else { continue }
        let staging = parent.appendingPathComponent("\(prefix)-\(getpid())")
        do {
          try fm.createDirectory(at: parent, withIntermediateDirectories: true)
          try fm.copyItem(at: source, to: staging)
          try fm.moveItem(at: staging, to: target)
        } catch {
          try? fm.removeItem(at: staging)
          throw AdoptionError(errorDescription: "复制 \(source.path) 没成：\(error.localizedDescription)")
        }
        copied.append(target.path)
      }
      try commitWebData(library, current, defaults)
      return copied
    }
  }

  /// 建窗口之前把网页数据接过来。返回 nil = 可以建窗口了；否则是还不能建的原因。没有可接的直接记已接。
  /// 旧 app 还开着就不复制：它的 WebKit 还在往那几个库里写，拷下来的不是一份一致的快照，而且只接一次。
  static func prepareWebData(library: URL, from legacy: String, to current: String, defaults: UserDefaults,
                             quitLegacy: () -> Bool) -> String? {
    guard !webDataSettled(library: library, current: current, defaults: defaults) else { return nil }
    let fm = FileManager.default
    do {
      guard webDataPairs(library: library, from: legacy, to: current).contains(where: { fm.fileExists(atPath: $0.0.path) }) else {
        try settleWebData(library: library, current: current, defaults: defaults)
        return nil
      }
      guard quitLegacy() else {
        return "Ash 还开着（可能在等你确认装更新，或者在等手上的任务停下来）。先把 Ash 退出，再点「重试」。"
      }
      let copied = try adoptWebData(library: library, from: legacy, to: current, defaults: defaults)
      if !copied.isEmpty { logger.notice("接过网页数据：\(copied.joined(separator: ", "), privacy: .public)") }
      return nil
    } catch {
      logger.error("\(error.localizedDescription, privacy: .public)")
      return error.localizedDescription
    }
  }

  // MARK: 启动时接班（窗口建出来之前调）

  /// 正式那份每次启动、建窗口之前都调。返回 nil 就可以建窗口了；否则是网页数据还接不过来的原因，由调用方问用户
  /// 重试、不接了（`skipWebData`）还是退出。接过的不再接；旧 app 还在用就在后台隔一会儿再试。
  static func adoptAtLaunch() -> String? {
    guard isSuccessor else { return nil }
    if let blocked = prepareWebData(library: userLibrary, from: bundleID, to: successor, defaults: .standard,
                                    quitLegacy: { quitLegacyApps(timeout: 8) }) {
      return blocked
    }
    guard LoginService.isInstalledLocation else { return nil }
    _ = quitLegacyApps(timeout: 8) // 让位时窗口进程得已经退了；退不了就等下一轮重试
    adoptLoginItem() // 第一次在主线程上换，赶在 LoginService.reconcileAtLaunch 之前
    retireWhenIdle()
    return nil
  }

  /// 请旧 app 的窗口退出，等它退干净（最多 timeout 秒）。返回是不是都退了：它可能在等用户确认装更新、等任务停下，
  /// 或者用户点了取消。服务不跟着退，那由 UpdateGate 换。
  private static func quitLegacyApps(timeout: TimeInterval) -> Bool {
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
    guard !running.isEmpty else { return true }
    running.forEach { $0.terminate() }
    let deadline = ProcessInfo.processInfo.systemUptime + timeout // 不按墙钟，见 withAdoptionLock
    while ProcessInfo.processInfo.systemUptime < deadline && running.contains(where: { !$0.isTerminated }) {
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    return running.allSatisfy { $0.isTerminated }
  }

  /// 旧的登录项（指着 Ash.app 里的 `Contents/MacOS/Ash`）。
  static var legacyLoginItem: URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(loginLabel).plist")
  }

  /// 登录自启已经有了 Navi 这边的决定：接班开上了，或者用户在菜单里开 / 关过（LoginService 每次开关成功都记）。
  /// 记过之后旧登录项那边只剩清理，**不再替用户开** —— 旧 plist 还在只说明上一轮没删掉，不说明用户现在还想开着。
  private static let loginChoiceKey = "LoginItemChoiceAfterAsh"

  static func noteLoginChoice(_ defaults: UserDefaults = .standard) { defaults.set(true, forKey: loginChoiceKey) }

  /// 卸掉并删除旧登录项（不在就算了）。删不掉抛错。
  static func removeLegacyLoginItem(_ item: URL = legacyLoginItem, bootout: (String) -> Void = { LoginService.bootout(label: $0) }) throws {
    bootout(loginLabel)
    guard FileManager.default.fileExists(atPath: item.path) else { return }
    try FileManager.default.removeItem(at: item)
  }

  /// 用户在菜单里关掉登录自启：先记下这个决定（后台重试从此不会再打开它），再连旧登录项一起卸掉删掉 —— 只关新的、
  /// 旧的还在，下次登录照样会起服务。旧的删不掉就抛错，让菜单那头说清楚，而不是报个关掉了。
  static func userTurnedLoginOff(_ item: URL = legacyLoginItem, defaults: UserDefaults = .standard,
                                 bootout: (String) -> Void = { LoginService.bootout(label: $0) }) throws {
    noteLoginChoice(defaults)
    do {
      try removeLegacyLoginItem(item, bootout: bootout)
    } catch {
      throw AdoptionError(errorDescription: "改名前的登录项 \(item.path) 删不掉，下次登录它还会起服务：\(error.localizedDescription)")
    }
  }

  /// 旧登录项还在（= 用户在 Ash 里开着）就换成自己的：**先把自己的装好、确认生效，再卸旧的**。反过来的话，新的那条
  /// 装不上时旧的已经没了，而抄过来的 LoginServiceConfigured 让之后的启动以为是用户关掉的，再也不会补上。装不上就两条
  /// 都原样留着，旧的 plist 在就是「还没换」：旧包也就不让位（`retire` 认它），旧登录项指着的 Ash 可执行文件一直在，
  /// 登录时照样起服务；让位的后台重试每一轮都再来一次。只有还没有过决定（`loginChoiceKey`）时才开新的。
  static func adoptLoginItem(_ item: URL = legacyLoginItem, defaults: UserDefaults = .standard,
                             enable: () throws -> Void = { try LoginService.setEnabled(true) },
                             bootout: (String) -> Void = { LoginService.bootout(label: $0) }) {
    guard FileManager.default.fileExists(atPath: item.path) else { return }
    if !defaults.bool(forKey: loginChoiceKey) {
      do {
        try enable()
      } catch {
        logger.error("换登录项没成，\(loginLabel, privacy: .public) 先留着、旧 app 也先不让位：\(error.localizedDescription, privacy: .public)")
        return
      }
      noteLoginChoice(defaults)
      logger.notice("登录项从 \(loginLabel, privacy: .public) 换成了 \(LoginService.label, privacy: .public)")
    }
    do {
      try removeLegacyLoginItem(item, bootout: bootout)
    } catch {
      logger.error("删不掉 \(item.path, privacy: .public)，下一轮再删：\(error.localizedDescription, privacy: .public)")
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

  /// 判「有没有人在用」要扫整张进程表（lsof），得花一两秒：放在后台，别卡住启动和窗口。
  private static let retireQueue = DispatchQueue(label: "dev.navi.mac.retire-legacy", qos: .utility)

  private static func retireWhenIdle() {
    retireQueue.async {
      DispatchQueue.main.sync { adoptLoginItem() } // 上一轮没换成的登录项先再换一次；跟菜单开关同在主线程，不交错
      let results = legacyBundles().map { retire($0, successor: Bundle.main.bundleURL) }
      for result in results { logger.notice("旧 app：\(String(describing: result), privacy: .public)") }
      guard results.contains(where: { if case .busy = $0 { return true } else { return false } }) else { return }
      retireQueue.asyncAfter(deadline: .now() + 15) { retireWhenIdle() }
    }
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

  /// 没人在用就移到废纸篓、原地放一个指向 `successor` 的软链。判「有没有人在用」与 install-app.sh 是同一套，用的
  /// 就是同一份 bundle-users.sh（随 app 带在 Resources 里）：
  ///  · 有代码锁就对它拿排他锁，拿到了一直拿到挪完（这期间想起来的进程在锁上等，等到时包已经不在原处）；
  ///  · 代码锁只管得到参加它的入口：别的进程直接跑包里的可执行文件、工作目录在包里、命令行经软链或相对路径提到它，
  ///    都按真实文件身份再扫一遍；
  ///  · 挪进废纸篓之后按打开着的文件再扫一遍，有人就挪回原处；原地放软链失败也挪回原处，免得写死旧路径的命令落空。
  /// 窗口进程不拿锁，单独认。扫不了就当有人在用。
  ///
  /// 「没人在用」还得包括**登记在外面、以后才会跑的**：旧登录项写死的是 `Ash.app/Contents/MacOS/Ash`，留下的
  /// 软链指向 Navi.app，那里只有 `MacOS/Navi`，旧登录项就落空了。所以旧登录项还在（还没换成 Navi 的）时不让位。
  /// 别处登记的都指着 `Contents/Resources/app/…`（CLI 的 MCP 登记），经软链照样走得通。
  static func retire(
    _ bundle: URL, successor: URL,
    usersScript: URL? = Bundle.main.url(forResource: "bundle-users", withExtension: "sh"),
    loginItem: URL? = legacyLoginItem,
    placeLink: (URL, URL) throws -> Void = { try FileManager.default.createSymbolicLink(at: $0, withDestinationURL: $1) }
  ) -> Retirement {
    let fm = FileManager.default
    if let gui = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
      .first(where: { $0.bundleURL?.standardizedFileURL == bundle.standardizedFileURL && !$0.isTerminated }) {
      return .busy("旧 app 的窗口进程 \(gui.processIdentifier) 还没退")
    }
    if let loginItem, fm.fileExists(atPath: loginItem.path) {
      return .busy("旧的登录项 \(loginItem.path) 还没换成 Navi 的，它跑的是旧包里的 Ash 可执行文件")
    }
    guard let usersScript, fm.fileExists(atPath: usersScript.path) else {
      return .failed("app 里没有 bundle-users.sh，判断不了旧 app 还有没有人在用")
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
    }
    defer { if descriptor >= 0 { close(descriptor) } }
    if let users = bundleUsers(bundle, script: usersScript) { return .busy("还有进程在用旧 app：\(users)") }
    var trashedURL: NSURL?
    do {
      try fm.trashItem(at: bundle, resultingItemURL: &trashedURL)
    } catch {
      return .failed("移不进废纸篓：\(error.localizedDescription)")
    }
    guard let trashed = trashedURL as URL? else { return .failed("移进废纸篓之后找不到它了") }
    if let users = bundleUsers(trashed, script: usersScript) {
      return putBack(trashed, to: bundle) ?? .busy("还有进程在用旧 app：\(users)")
    }
    do {
      try placeLink(bundle, successor)
    } catch {
      return putBack(trashed, to: bundle) ?? .failed("原地放不了指向 Navi 的软链，旧 app 已放回原处：\(error.localizedDescription)")
    }
    return .retired(trashedAt: trashed.path)
  }

  /// 挪回原处。返回 nil = 放回去了；放不回去时说清它在哪。
  private static func putBack(_ trashed: URL, to bundle: URL) -> Retirement? {
    do {
      try FileManager.default.moveItem(at: trashed, to: bundle)
      return nil
    } catch {
      return .failed("旧 app 在废纸篓里（\(trashed.path)），放不回 \(bundle.path)：\(error.localizedDescription)")
    }
  }

  /// bundle-users.sh 认出来的、还在用这个包的进程（每行「pid 命令行」）；没人用是 nil，扫不了也算有人。
  private static func bundleUsers(_ bundle: URL, script: URL) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [script.path, bundle.path]
    // 自己拿着代码锁的排他锁，lsof 会把自己也列出来：跟安装器一样告诉它这一个不算。
    process.environment = ProcessInfo.processInfo.environment.merging(["NAVI_LOCK_HOLDER": String(getpid())]) { $1 }
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return "（查不了进程表）" }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return "（查进程表出错：\(process.terminationStatus)）" }
    let users = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return users.isEmpty ? nil : users.replacingOccurrences(of: "\n", with: "；")
  }
}
