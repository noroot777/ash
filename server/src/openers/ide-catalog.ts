// 「本机装了哪些编程 IDE」靠的是一张写死的清单,不是系统的文件关联。
//
// 为什么不复用 openers/ 里那三条平台探测:那三条回答的是「谁声明了能打开这种文件」。
// 对一个**文件夹**问同样的问题,macOS 会把所有声明 `public.folder` 的东西都端上来
// (访达、解压工具、同步盘客户端),Windows 的注册表干脆对目录没有 OpenWithProgids ——
// 两边都答不出用户真正要的那一个。「编程 IDE」是人定义的类别,系统没有这个概念,所以
// 只能由我们列出来再去本机找。
//
// 代价是清单要维护:出了新编辑器、或者某个 IDE 换了 bundle 名,这里不加就探不到。
// 兜底是 `commands` 那一列 —— 装了 CLI(`code`/`cursor`/`idea`)的机器即使 .app 放在
// 非标准位置也能被 PATH 捞到。

/** 一个已知 IDE 在三个平台上分别长什么样。字段全是「候选」,命中一个就算装了。 */
export interface IdeSpec {
  id: string;
  name: string;
  /** macOS: .app 的文件名(含后缀)。渠道/版本不同会有多个名字。 */
  macApps?: string[];
  /** 所有平台: PATH 上的命令名。Windows 侧会按 PATHEXT 补 .cmd/.exe。 */
  commands?: string[];
  /**
   * Windows: 相对基准目录的可执行文件路径。`{LOCALAPPDATA}` 这类占位符由
   * windows 侧按真实环境变量展开(见 ide.ts 的 expandWindowsBase)。
   */
  windowsPaths?: string[];
  /** Linux: 绝对路径候选(包管理器/官方 tar 包的常见落点)。 */
  linuxPaths?: string[];
}

// VS Code 家族共用一套命令行形状(`<exe> <dir>` 就是打开文件夹),JetBrains 家族也是。
// 分档只是为了列表里能排个序:日常在用的放前面,Xcode / 通用编辑器垫后。
export const IDE_CATALOG: readonly IdeSpec[] = [
  // ── VS Code 家族 ──────────────────────────────────────────────────────────
  {
    id: "vscode",
    name: "Visual Studio Code",
    macApps: ["Visual Studio Code.app"],
    commands: ["code"],
    windowsPaths: [
      "{LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe",
      "{PROGRAMFILES}/Microsoft VS Code/Code.exe",
      "{PROGRAMFILESX86}/Microsoft VS Code/Code.exe",
    ],
    linuxPaths: ["/usr/share/code/code", "/opt/visual-studio-code/code"],
  },
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    macApps: ["Visual Studio Code - Insiders.app"],
    commands: ["code-insiders"],
    windowsPaths: ["{LOCALAPPDATA}/Programs/Microsoft VS Code Insiders/Code - Insiders.exe"],
  },
  {
    id: "cursor",
    name: "Cursor",
    macApps: ["Cursor.app"],
    commands: ["cursor"],
    windowsPaths: [
      "{LOCALAPPDATA}/Programs/cursor/Cursor.exe",
      "{LOCALAPPDATA}/Programs/Cursor/Cursor.exe",
    ],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    macApps: ["Windsurf.app"],
    commands: ["windsurf"],
    windowsPaths: ["{LOCALAPPDATA}/Programs/Windsurf/Windsurf.exe"],
  },
  {
    id: "trae",
    name: "Trae",
    macApps: ["Trae.app", "Trae CN.app"],
    commands: ["trae"],
    windowsPaths: ["{LOCALAPPDATA}/Programs/Trae/Trae.exe", "{LOCALAPPDATA}/Programs/Trae CN/Trae CN.exe"],
  },
  {
    id: "qoder",
    name: "Qoder",
    macApps: ["Qoder.app", "QoderWork CN.app"],
    commands: ["qoder"],
    windowsPaths: ["{LOCALAPPDATA}/Programs/Qoder/Qoder.exe"],
  },
  {
    id: "kiro",
    name: "Kiro",
    macApps: ["Kiro.app"],
    commands: ["kiro"],
    windowsPaths: ["{LOCALAPPDATA}/Programs/Kiro/Kiro.exe"],
  },
  {
    id: "antigravity",
    name: "Antigravity",
    macApps: ["Antigravity.app"],
    commands: ["antigravity"],
    windowsPaths: ["{LOCALAPPDATA}/Programs/Antigravity/Antigravity.exe"],
  },
  {
    id: "vscodium",
    name: "VSCodium",
    macApps: ["VSCodium.app"],
    commands: ["codium"],
    windowsPaths: ["{LOCALAPPDATA}/Programs/VSCodium/VSCodium.exe"],
    linuxPaths: ["/usr/share/codium/codium"],
  },
  {
    id: "positron",
    name: "Positron",
    macApps: ["Positron.app"],
    commands: ["positron"],
  },

  // ── JetBrains 家族 ────────────────────────────────────────────────────────
  // Toolbox 装的版本会在 PATH 里放一个同名脚本(macOS/Linux 是 shell 脚本,Windows 是
  // .cmd),所以 commands 那一列对 Toolbox 用户往往先命中。
  {
    id: "intellij",
    name: "IntelliJ IDEA",
    macApps: ["IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app", "IntelliJ IDEA CE.app"],
    commands: ["idea"],
    windowsPaths: ["{LOCALAPPDATA}/JetBrains/Toolbox/scripts/idea.cmd"],
  },
  { id: "webstorm", name: "WebStorm", macApps: ["WebStorm.app"], commands: ["webstorm"], windowsPaths: ["{LOCALAPPDATA}/JetBrains/Toolbox/scripts/webstorm.cmd"] },
  { id: "pycharm", name: "PyCharm", macApps: ["PyCharm.app", "PyCharm Professional.app", "PyCharm CE.app"], commands: ["pycharm"], windowsPaths: ["{LOCALAPPDATA}/JetBrains/Toolbox/scripts/pycharm.cmd"] },
  { id: "goland", name: "GoLand", macApps: ["GoLand.app"], commands: ["goland"], windowsPaths: ["{LOCALAPPDATA}/JetBrains/Toolbox/scripts/goland.cmd"] },
  { id: "clion", name: "CLion", macApps: ["CLion.app"], commands: ["clion"], windowsPaths: ["{LOCALAPPDATA}/JetBrains/Toolbox/scripts/clion.cmd"] },
  { id: "phpstorm", name: "PhpStorm", macApps: ["PhpStorm.app"], commands: ["phpstorm"], windowsPaths: ["{LOCALAPPDATA}/JetBrains/Toolbox/scripts/phpstorm.cmd"] },
  { id: "rubymine", name: "RubyMine", macApps: ["RubyMine.app"], commands: ["rubymine"], windowsPaths: ["{LOCALAPPDATA}/JetBrains/Toolbox/scripts/rubymine.cmd"] },
  { id: "rider", name: "Rider", macApps: ["Rider.app", "JetBrains Rider.app"], commands: ["rider"], windowsPaths: ["{LOCALAPPDATA}/JetBrains/Toolbox/scripts/rider.cmd"] },
  { id: "rustrover", name: "RustRover", macApps: ["RustRover.app"], commands: ["rustrover"], windowsPaths: ["{LOCALAPPDATA}/JetBrains/Toolbox/scripts/rustrover.cmd"] },
  { id: "datagrip", name: "DataGrip", macApps: ["DataGrip.app"], commands: ["datagrip"], windowsPaths: ["{LOCALAPPDATA}/JetBrains/Toolbox/scripts/datagrip.cmd"] },
  { id: "fleet", name: "Fleet", macApps: ["Fleet.app"], commands: ["fleet"] },
  {
    id: "android-studio",
    name: "Android Studio",
    macApps: ["Android Studio.app"],
    commands: ["studio"],
    windowsPaths: ["{PROGRAMFILES}/Android/Android Studio/bin/studio64.exe"],
    linuxPaths: ["/opt/android-studio/bin/studio.sh"],
  },

  // ── 其余编辑器 ────────────────────────────────────────────────────────────
  { id: "zed", name: "Zed", macApps: ["Zed.app"], commands: ["zed"], linuxPaths: ["/usr/bin/zeditor"] },
  { id: "sublime", name: "Sublime Text", macApps: ["Sublime Text.app"], commands: ["subl"], windowsPaths: ["{PROGRAMFILES}/Sublime Text/sublime_text.exe"] },
  { id: "nova", name: "Nova", macApps: ["Nova.app"], commands: ["nova"] },
  { id: "bbedit", name: "BBEdit", macApps: ["BBEdit.app"], commands: ["bbedit"] },
  { id: "lapce", name: "Lapce", macApps: ["Lapce.app"], commands: ["lapce"] },
  {
    id: "visual-studio",
    name: "Visual Studio",
    windowsPaths: [
      "{PROGRAMFILES}/Microsoft Visual Studio/2022/Community/Common7/IDE/devenv.exe",
      "{PROGRAMFILES}/Microsoft Visual Studio/2022/Professional/Common7/IDE/devenv.exe",
      "{PROGRAMFILES}/Microsoft Visual Studio/2022/Enterprise/Common7/IDE/devenv.exe",
    ],
  },
  { id: "xcode", name: "Xcode", macApps: ["Xcode.app", "Xcode-beta.app"] },
];
