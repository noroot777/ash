import Foundation

/// 「登录时启动 ash 服务」：一份 LaunchAgent，登录时跑一次 `Ash --start-server`
/// （见 main.swift），起法与打开 app 时完全同一条路径，只是不开窗口。
///
/// 只在登录那一刻跑一次，不设 KeepAlive：服务的重启归 `npm run restart`，launchd 若也守着它，
/// restart 一杀它就被 launchd 拉回来，两边抢同一个端口。
enum LoginService {
  static let label = "dev.ash.server"

  static var plistURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/LaunchAgents/\(label).plist")
  }

  static var isEnabled: Bool {
    FileManager.default.fileExists(atPath: plistURL.path)
      && launchctl(["print", "gui/\(getuid())/\(label)"]) == 0
  }

  /// app 启动时调：装进「应用程序」后第一次打开就默认开上（用户要的就是「不用自己起服务」），
  /// 之后尊重菜单里的开关。从构建目录里直接跑的那份不自动登记，免得把一个随时会被删的
  /// 路径写进登录项。已开着但 app 换了位置时重写一份。
  static func reconcileAtLaunch() throws {
    let configured = "LoginServiceConfigured"
    let installed = ["/Applications/", "\(NSHomeDirectory())/Applications/"].contains { Bundle.main.bundlePath.hasPrefix($0) }
    if installed && !UserDefaults.standard.bool(forKey: configured) {
      try setEnabled(true)
      return
    }
    guard installed, FileManager.default.fileExists(atPath: plistURL.path),
          !isEnabled || registeredExecutable != Bundle.main.executablePath else { return }
    try setEnabled(true)
  }

  private static var registeredExecutable: String? {
    guard let data = try? Data(contentsOf: plistURL),
          let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
          let args = plist["ProgramArguments"] as? [String] else { return nil }
    return args.first
  }

  static func setEnabled(_ enabled: Bool) throws {
    let domain = "gui/\(getuid())"
    // 先卸再装：app 挪过位置或重装后，旧那份里的可执行路径就过期了。
    if launchctl(["print", "\(domain)/\(label)"]) == 0 {
      try checkedLaunchctl(["bootout", "\(domain)/\(label)"])
    }
    guard enabled else {
      if FileManager.default.fileExists(atPath: plistURL.path) {
        try FileManager.default.removeItem(at: plistURL)
      }
      UserDefaults.standard.set(true, forKey: "LoginServiceConfigured")
      return
    }
    guard let executable = Bundle.main.executablePath else {
      throw NSError(domain: NSCocoaErrorDomain, code: NSFileNoSuchFileError)
    }
    let plist: [String: Any] = [
      "Label": label,
      "ProgramArguments": [executable, "--start-server"],
      "RunAtLoad": true,
      "LimitLoadToSessionType": "Aqua",
      // server 由 start-detached 放进了自己的会话，这条只是再保一层：本 job 退出时 launchd 不清它的进程组。
      "AbandonProcessGroup": true,
      "StandardOutPath": "/tmp/ash-mac-login.log",
      "StandardErrorPath": "/tmp/ash-mac-login.log",
    ]
    try FileManager.default.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    try data.write(to: plistURL, options: .atomic)
    try checkedLaunchctl(["bootstrap", domain, plistURL.path])
    guard isEnabled else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(EIO)) }
    UserDefaults.standard.set(true, forKey: "LoginServiceConfigured")
  }

  private static func checkedLaunchctl(_ args: [String]) throws {
    let status = launchctl(args)
    guard status == 0 else {
      throw NSError(domain: "AshLoginService", code: Int(status), userInfo: [
        NSLocalizedDescriptionKey: "登录项操作失败：launchctl \(args.joined(separator: " "))（\(status)）",
      ])
    }
  }

  @discardableResult
  private static func launchctl(_ args: [String]) -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = args
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return -1 }
    process.waitUntilExit()
    return process.terminationStatus
  }
}
