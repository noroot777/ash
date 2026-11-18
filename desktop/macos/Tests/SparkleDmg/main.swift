import AppKit
import Sparkle

// scripts/test-macos-sparkle-dmg.mjs 的宿主 app：一个只带 Sparkle 的空壳 app（Navi.app，或改名前的 Ash.app），Info.plist 里的更新配置与
// build.sh 写的同一套（EdDSA 公钥、SURequireSignedFeed、SUVerifyUpdateBeforeExtraction）。界面那一层换成照单
// 全收的 SPUUserDriver：查到就装、下好就装并重开；每一步往 Info.plist 的 ProbeLog 记一行给测试读。
// 带 ProbeCheck 的那一版（旧版）一打开就查更新；不带的（新版，被 Sparkle 重开的那个）记一行就退。

let info = Bundle.main.infoDictionary ?? [:]
let logPath = info["ProbeLog"] as? String ?? "/dev/null"
let version = info["CFBundleVersion"] as? String ?? "?"

func emit(_ line: String) {
  guard let data = "\(line)\n".data(using: .utf8) else { return }
  if let handle = FileHandle(forWritingAtPath: logPath) {
    handle.seekToEndOfFile()
    handle.write(data)
    handle.closeFile()
  } else {
    FileManager.default.createFile(atPath: logPath, contents: data)
  }
}

/// 一个错误连同它的底层原因，一行写完（验签失败的具体说法在底层那几层里）。
func describe(_ error: Error) -> String {
  var parts: [String] = []
  var current: NSError? = error as NSError
  while let next = current, parts.count < 6 {
    parts.append("\(next.domain)#\(next.code) \(next.localizedDescription)")
    current = next.userInfo[NSUnderlyingErrorKey] as? NSError
  }
  return parts.joined(separator: " <- ").replacingOccurrences(of: "\n", with: " ")
}

final class AcceptEverything: NSObject, SPUUserDriver {
  func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
    reply(SUUpdatePermissionResponse(automaticUpdateChecks: false, sendSystemProfile: false))
  }
  func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) { emit("CHECKING") }
  func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
    // 「仅通知」的条目（改名前的 Ash.app 收到的那种）：没有可装的东西，记下它指向哪就退。
    if appcastItem.isInformationOnlyUpdate {
      emit("INFORMATIONAL \(appcastItem.versionString) \(appcastItem.infoURL?.absoluteString ?? "-")")
      reply(.dismiss)
      NSApp.terminate(nil)
      return
    }
    emit("FOUND \(appcastItem.versionString)")
    reply(.install)
  }
  func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
  func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}
  func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
    emit("NOT-FOUND \(describe(error))")
    acknowledgement()
    NSApp.terminate(nil)
  }
  func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
    emit("ERROR \(describe(error))")
    acknowledgement()
    NSApp.terminate(nil)
  }
  func showDownloadInitiated(cancellation: @escaping () -> Void) { emit("DOWNLOADING") }
  func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {}
  func showDownloadDidReceiveData(ofLength length: UInt64) {}
  func showDownloadDidStartExtractingUpdate() { emit("EXTRACTING") }
  func showExtractionReceivedProgress(_ progress: Double) {}
  func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
    emit("READY")
    reply(.install)
  }
  func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
    emit("INSTALLING")
  }
  func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) { acknowledgement() }
  func dismissUpdateInstallation() {}
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
emit("LAUNCHED \(version) \(Bundle.main.bundlePath)")
guard info["ProbeCheck"] as? Bool == true else { exit(0) }

let driver = AcceptEverything()
let updater = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: driver, delegate: nil)
do {
  try updater.start()
} catch {
  emit("ERROR \(describe(error))")
  exit(1)
}
updater.checkForUpdates()
app.run()
