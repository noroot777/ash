import AppKit

// 入口。没有 storyboard / nib：菜单和窗口都在代码里建，整个 app 由 build.sh 一条 swiftc 编出来。
//
// `--start-server` 是无窗口的一档：确保服务在跑就退出，给登录时的 LaunchAgent 用（见 LoginService）。
// 数据根还是空的时候它不起：首启要问用户「全新开始还是导入」，抢先建一份空库就没得导了。
if CommandLine.arguments.contains("--start-server") {
  switch ServerLauncher.shared.ensureRunningSync(timeout: 60) {
  case .ready:
    print("ash 服务已就绪：\(AshConfig.baseURL.absoluteString)")
    exit(0)
  case .needsSetup:
    print("\(AshConfig.dataURL.path) 里还没有数据：先打开一次 ash 选「全新开始」或「导入已有数据」。")
    exit(0)
  case .occupied(let explanation):
    print(explanation)
    exit(1)
  case .failed(let reason):
    print("ash 服务没起来：\(reason)")
    exit(1)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
