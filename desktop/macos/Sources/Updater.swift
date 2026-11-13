import AppKit
import Sparkle

/// 自更新：Sparkle 管查、下载、验签、换 app、重开；装之前那一步交给 UpdateGate（会不会打断任务、
/// 停服务、备份库）。
///
/// 校验只靠 EdDSA：app 是 ad-hoc 签名，没有能跨版本延续的 Apple 签名身份，Sparkle 的规则是两者
/// 至少有一样不变 —— 所以 Info.plist 里的 SUPublicEDKey **永远不能换**，换了已装的 app 就再也装
/// 不上新版。appcast 本身也要签过（SURequireSignedFeed），压缩包先验签再解压
/// （SUVerifyUpdateBeforeExtraction）。这些键由 build.sh 按 release.json 写进 Info.plist；公钥还没
/// 配的构建不带它们，这里也就不启动。
///
/// 装更新的三条路，都过同一道闸：
///  · 用户点了「安装并重新启动」→ `shouldPostponeRelaunchForUpdate` 先压住，闸放行再继续
///  · 用户勾了自动安装、Sparkle 悄悄下好了 → `willInstallUpdateOnQuit`：接过安装权，闸放行就装、
///    装完重开（ash 是常驻的，等它「退出时装」可能要等好几天）
///  · 下好了但还没装、用户按了 ⌘Q → 退出时 Sparkle 照样会装：AppDelegate 的
///    applicationShouldTerminate 走 `requestForQuit`
final class AppUpdater: NSObject, SPUUpdaterDelegate {
  static let shared = AppUpdater()

  private var controller: SPUStandardUpdaterController?
  /// 已经有一份下好、解开的新版在等着装（退出时 Sparkle 会装它）。
  private(set) var readyVersion: String?

  /// 这份构建带不带更新源（公钥没配的开发构建不带）。
  static var isConfigured: Bool {
    let info = Bundle.main.infoDictionary ?? [:]
    return !(info["SUFeedURL"] as? String ?? "").isEmpty && !(info["SUPublicEDKey"] as? String ?? "").isEmpty
  }

  func start() {
    guard Self.isConfigured, controller == nil else { return }
    controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
  }

  /// 「检查更新…」的目标对象（它自己按 canCheckForUpdates 决定菜单项能不能点）。
  var menuTarget: AnyObject? { controller }

  // MARK: SPUUpdaterDelegate

  func updater(_ updater: SPUUpdater, didExtractUpdate item: SUAppcastItem) {
    readyVersion = item.displayVersionString
  }

  func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
               untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
    readyVersion = item.displayVersionString
    UpdateGate.shared.request(.update(version: label(item)), proceed: installHandler)
    return true
  }

  func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
               immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
    readyVersion = item.displayVersionString
    UpdateGate.shared.request(.update(version: label(item)), proceed: immediateInstallHandler)
    return true
  }

  func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
    let code = (error as NSError).code
    // 「没有新版」也走这里，那不算放弃了已经下好的那份。
    if code != Int(SUError.noUpdateError.rawValue) { readyVersion = nil }
    UpdateGate.logger.notice("Sparkle 中止：\(error.localizedDescription, privacy: .public)")
  }

  private func label(_ item: SUAppcastItem) -> String {
    "\(item.displayVersionString)（\(item.versionString)）"
  }
}
