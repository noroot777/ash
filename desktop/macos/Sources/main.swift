import AppKit

// 入口。没有 storyboard / nib：菜单和窗口都在代码里建，整个 app 由 build.sh 一条 swiftc 编出来。
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
