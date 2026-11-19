// 改名脚本的手写修复层（scripts/rename-navi.mjs 在机械改名之后逐份套上）：机械换不出来、交付又离不开的那几处。
// 每份带一个记号：文件里已经有记号就算修过了，之后再怎么改都不碰；没有就逐段按原文替换，哪段对不上整次拒绝。
// 段落是「改名之后的原文 → 修好之后」，所以 from 里的名字已经是 navi；旧名（ASH_…）是兼容要读的值，不是漏换。
// 带 content 的是整份新加的文件：还没有就建出来。
export const FIXES = [
  {
    "file": "desktop/macos/Sources/LegacyIdentity.swift",
    "why": "旧环境变量兼容：两代名字的读取与打架判定（新名优先、退到 ASH_，空串算没设）",
    "marker": "static func environmentConflict(",
    "hunks": [
      {
        "from": "\n  private static var isSuccessor: Bool { Bundle.main.bundleIdentifier == successor }\n\n  // MARK: 设置\n",
        "to": "\n  private static var isSuccessor: Bool { Bundle.main.bundleIdentifier == successor }\n\n  // MARK: 环境变量\n\n  /// 环境变量的旧前缀：改名前的启动配置（`ASH_URL`、`ASH_DATA_DIR` 这类，构建测试用的那几个口子也一样）照样认。\n  /// 口径同 scripts/env.mjs：新名优先，新名没设（或是空串）才退到旧名。\n  static let envPrefix = \"ASH_\"\n\n  /// 一个 `NAVI_` 开头的变量的值：新名优先，退到旧名；空串当没设。\n  static func environment(_ name: String, in env: [String: String]) -> String? {\n    envGenerations(name).lazy.compactMap { env[$0] }.first { !$0.isEmpty }\n  }\n\n  /// 指向数据的变量（连哪台、数据根）：两代都设了、值又不一样，就说不清该用哪一份 —— 返回冲突说明，调用方\n  /// 拒绝打开，不替用户挑（挑错了就是开着另一份数据、原来的任务「不见了」）。同 scripts/env.mjs 的 readStorageEnv。\n  static func environmentConflict(_ name: String, in env: [String: String]) -> String? {\n    let set = envGenerations(name).compactMap { key -> (String, String)? in\n      guard let value = env[key]?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }\n      return (key, value)\n    }\n    guard let first = set.first, let other = set.dropFirst().first(where: { $0.1 != first.1 }) else { return nil }\n    return \"\\(first.0)=\\(first.1) 和 \\(other.0)=\\(other.1) 同时设了、指向不同的地方，不知道该用哪一个：擦掉其中一个再打开。\"\n  }\n\n  private static func envGenerations(_ name: String) -> [String] {\n    precondition(name.hasPrefix(\"NAVI_\"), \"环境变量名必须以 NAVI_ 开头：\\(name)\")\n    return [name, envPrefix + name.dropFirst(\"NAVI_\".count)]\n  }\n\n  // MARK: 设置\n"
      }
    ]
  },
  {
    "file": "desktop/macos/Sources/NaviConfig.swift",
    "why": "旧环境变量兼容：mac 应用的每个环境变量都经两代读取",
    "marker": "LegacyIdentity.environment(",
    "hunks": [
      {
        "from": "/// 环境变量那几个口子是给验证用的：把 app 拷到别处、用临时数据根和临时端口起一份，碰不到\n/// 日常那一份（`NAVI_URL` + `NAVI_DATA_DIR` 就够了；`NAVI_MAC_RUNTIME` / `NAVI_MAC_DOWNLOAD_JOURNAL`\n/// 只给回归测试换成假的）。\nenum NaviConfig {\n  private static let env = ProcessInfo.processInfo.environment\n\n  /// 优先级：环境变量 NAVI_URL > `defaults write dev.navi.mac NaviURL <url>` > 本机 4317。\n  static let baseURL: URL = {\n    for raw in [env[\"NAVI_URL\"], UserDefaults.standard.string(forKey: \"NaviURL\")] {\n      if let raw, let url = URL(string: raw.trimmingCharacters(in: .whitespaces)), url.host != nil {\n        return url\n",
        "to": "/// 环境变量那几个口子是给验证用的：把 app 拷到别处、用临时数据根和临时端口起一份，碰不到\n/// 日常那一份（`NAVI_URL` + `NAVI_DATA_DIR` 就够了；`NAVI_MAC_RUNTIME` / `NAVI_MAC_DOWNLOAD_JOURNAL`\n/// 只给回归测试换成假的）。改名前的旧名照样认，新名优先（`LegacyIdentity.environment`）。\nenum NaviConfig {\n  private static let environment = ProcessInfo.processInfo.environment\n  private static func env(_ name: String) -> String? { LegacyIdentity.environment(name, in: environment) }\n\n  /// 新旧两代变量指着不同的服务或数据根：说不清该开哪一份，入口据此拒绝打开（见 main.swift）。\n  static var environmentConflict: String? {\n    [\"NAVI_URL\", \"NAVI_DATA_DIR\"].lazy.compactMap { LegacyIdentity.environmentConflict($0, in: environment) }.first\n  }\n\n  /// 优先级：环境变量 NAVI_URL > `defaults write dev.navi.mac NaviURL <url>` > 本机 4317。\n  static let baseURL: URL = {\n    for raw in [env(\"NAVI_URL\"), UserDefaults.standard.string(forKey: \"NaviURL\")] {\n      if let raw, let url = URL(string: raw.trimmingCharacters(in: .whitespaces)), url.host != nil {\n        return url\n"
      },
      {
        "from": "  /// 每次起服务都是同一个端口，页面的本地设置（主题、草稿）跟着这个地址留得住。\n  static let windowPort: Int = {\n    if let raw = env[\"NAVI_MAC_WINDOW_PORT\"], let port = Int(raw), (1...65535).contains(port) { return port }\n    var hash: UInt32 = 2_166_136_261\n    for byte in NaviHealth.realPath(dataURL.path).utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }\n",
        "to": "  /// 每次起服务都是同一个端口，页面的本地设置（主题、草稿）跟着这个地址留得住。\n  static let windowPort: Int = {\n    if let raw = env(\"NAVI_MAC_WINDOW_PORT\"), let port = Int(raw), (1...65535).contains(port) { return port }\n    var hash: UInt32 = 2_166_136_261\n    for byte in NaviHealth.realPath(dataURL.path).utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }\n"
      },
      {
        "from": "  /// 自带的那份 navi（`scripts/bundle-runtime.mjs` 装进来的，布局见那份脚本顶部）。\n  static var runtimeURL: URL {\n    if let raw = env[\"NAVI_MAC_RUNTIME\"], !raw.isEmpty { return URL(fileURLWithPath: raw, isDirectory: true) }\n    return Bundle.main.resourceURL!.appendingPathComponent(\"app\", isDirectory: true)\n  }\n",
        "to": "  /// 自带的那份 navi（`scripts/bundle-runtime.mjs` 装进来的，布局见那份脚本顶部）。\n  static var runtimeURL: URL {\n    if let raw = env(\"NAVI_MAC_RUNTIME\") { return URL(fileURLWithPath: raw, isDirectory: true) }\n    return Bundle.main.resourceURL!.appendingPathComponent(\"app\", isDirectory: true)\n  }\n"
      },
      {
        "from": "  /// `NAVI_DATA_DIR` 或 `defaults write dev.navi.mac NaviDataDir <目录>` 可以改指。\n  static let dataURL: URL = {\n    let raw = env[\"NAVI_DATA_DIR\"].flatMap { $0.isEmpty ? nil : $0 }\n      ?? UserDefaults.standard.string(forKey: \"NaviDataDir\").flatMap { $0.isEmpty ? nil : $0 }\n    return raw.map { URL(fileURLWithPath: $0, isDirectory: true).standardizedFileURL } ?? supportURL\n",
        "to": "  /// `NAVI_DATA_DIR` 或 `defaults write dev.navi.mac NaviDataDir <目录>` 可以改指。\n  static let dataURL: URL = {\n    let raw = env(\"NAVI_DATA_DIR\")\n      ?? UserDefaults.standard.string(forKey: \"NaviDataDir\").flatMap { $0.isEmpty ? nil : $0 }\n    return raw.map { URL(fileURLWithPath: $0, isDirectory: true).standardizedFileURL } ?? supportURL\n"
      },
      {
        "from": "  /// 下载事务的登记放哪（见 DownloadTransaction）。\n  static var downloadJournalURL: URL {\n    if let raw = env[\"NAVI_MAC_DOWNLOAD_JOURNAL\"], !raw.isEmpty { return URL(fileURLWithPath: raw, isDirectory: true) }\n    return supportURL.appendingPathComponent(\"downloads\", isDirectory: true)\n  }\n",
        "to": "  /// 下载事务的登记放哪（见 DownloadTransaction）。\n  static var downloadJournalURL: URL {\n    if let raw = env(\"NAVI_MAC_DOWNLOAD_JOURNAL\") { return URL(fileURLWithPath: raw, isDirectory: true) }\n    return supportURL.appendingPathComponent(\"downloads\", isDirectory: true)\n  }\n"
      }
    ]
  },
  {
    "file": "desktop/macos/Sources/main.swift",
    "why": "旧环境变量兼容：连哪台、数据根两代打架就拒绝打开",
    "marker": "NaviConfig.environmentConflict",
    "hunks": [
      {
        "from": "// 改名前（Ash.app）的设置先接过来：下面不管哪一档，读到的都是同一份设置（见 LegacyIdentity）。\nLegacyIdentity.adoptDefaultsAtLaunch()\n\nif CommandLine.arguments.contains(\"--start-server\") {\n",
        "to": "// 改名前（Ash.app）的设置先接过来：下面不管哪一档，读到的都是同一份设置（见 LegacyIdentity）。\nLegacyIdentity.adoptDefaultsAtLaunch()\n\n// 新旧两代环境变量指着不同的服务或数据根：不替用户挑，说明白了就退（见 LegacyIdentity.environmentConflict）。\nif let conflict = NaviConfig.environmentConflict {\n  FileHandle.standardError.write(Data(\"Navi 没有打开：\\(conflict)\\n\".utf8))\n  if !CommandLine.arguments.contains(\"--start-server\") {\n    NSApplication.shared.setActivationPolicy(.regular)\n    NSApp.activate(ignoringOtherApps: true)\n    let alert = NSAlert()\n    alert.messageText = \"Navi 没有打开\"\n    alert.informativeText = conflict\n    alert.runModal()\n  }\n  exit(1)\n}\n\nif CommandLine.arguments.contains(\"--start-server\") {\n"
      }
    ]
  },
  {
    "file": "desktop/macos/Tests/main.swift",
    "why": "旧环境变量兼容：测试驱动能看到配置读出来的结果",
    "marker": "NaviConfig.environmentConflict",
    "hunks": [
      {
        "from": "  require(received == 8, \"every merged request receives a result\")\n  require(failed, \"fixture intentionally fails\")\n  exit(0)\n}\n",
        "to": "  require(received == 8, \"every merged request receives a result\")\n  require(failed, \"fixture intentionally fails\")\n  exit(0)\n}\nif mode == \"config\" {\n  // 环境变量各代怎么认：新名优先、退到旧名，指向数据的两代打架就拒绝。\n  if let conflict = NaviConfig.environmentConflict { print(\"CONFLICT \\(conflict)\"); exit(1) }\n  print(\"url=\\(NaviConfig.baseURL.absoluteString)\")\n  print(\"data=\\(NaviConfig.dataURL.path)\")\n  print(\"window=\\(NaviConfig.windowPort)\")\n  print(\"runtime=\\(NaviConfig.runtimeURL.path)\")\n  print(\"journal=\\(NaviConfig.downloadJournalURL.path)\")\n  exit(0)\n}\n"
      }
    ]
  },
  {
    "file": "desktop/macos/build.sh",
    "why": "旧环境变量兼容：构建参数新名优先、退到 ASH_MAC_",
    "marker": "${ASH_MAC_",
    "hunks": [
      {
        "from": "#   NAVI_MAC_BUNDLE_ID                         换 bundle id：defaults、数据根、登录项都跟着分开\n#   NAVI_MAC_BUILD_NUMBER                      指定 CFBundleVersion，造一新一旧两个版本\nset -euo pipefail\n\n",
        "to": "#   NAVI_MAC_BUNDLE_ID                         换 bundle id：defaults、数据根、登录项都跟着分开\n#   NAVI_MAC_BUILD_NUMBER                      指定 CFBundleVersion，造一新一旧两个版本\n# 这几个口子改名前叫 ASH_MAC_*，旧名照样认、新名优先（下面读的时候各退一档）。\nset -euo pipefail\n\n"
      },
      {
        "from": "  BOOK=\"$BUILD/.build-number\"\nfi\n[[ -n \"${NAVI_MAC_BUILD_NUMBER_FILE:-}\" ]] && BOOK=\"$NAVI_MAC_BUILD_NUMBER_FILE\" LEGACY_BOOK=\"\"\nmkdir -p \"$(dirname \"$BOOK\")\"\ntouch \"$BOOK\"\n# NAVI_MAC_BUILD_NUMBER 指定时不碰账本（演练造一新一旧两版用）。改名前的账本（ash-mac-build-number）在锁里当底读，见 build-number.mjs。\nBUILD_NUMBER=\"${NAVI_MAC_BUILD_NUMBER:-$(lockf -k \"$BOOK\" node \"$HERE/scripts/build-number.mjs\" \"$BOOK\" ${LEGACY_BOOK:+\"$LEGACY_BOOK\"})}\"\n# 包标识改名前是 dev.ash.mac：已装的旧版怎么接到这一版，见 Sources/LegacyIdentity.swift 和 README「从 Ash.app 升级」。\nBUNDLE_ID=\"${NAVI_MAC_BUNDLE_ID:-dev.navi.mac}\"\n\n# 更新源：release.json 里放 appcast 的那个仓库（feedRepo，不是放安装包的 releaseRepo）→\n",
        "to": "  BOOK=\"$BUILD/.build-number\"\nfi\nBOOK_OVERRIDE=\"${NAVI_MAC_BUILD_NUMBER_FILE:-${ASH_MAC_BUILD_NUMBER_FILE:-}}\"\n[[ -n \"$BOOK_OVERRIDE\" ]] && BOOK=\"$BOOK_OVERRIDE\" LEGACY_BOOK=\"\"\nmkdir -p \"$(dirname \"$BOOK\")\"\ntouch \"$BOOK\"\n# NAVI_MAC_BUILD_NUMBER 指定时不碰账本（演练造一新一旧两版用）。改名前的账本（ash-mac-build-number）在锁里当底读，见 build-number.mjs。\nBUILD_NUMBER=\"${NAVI_MAC_BUILD_NUMBER:-${ASH_MAC_BUILD_NUMBER:-}}\"\nBUILD_NUMBER=\"${BUILD_NUMBER:-$(lockf -k \"$BOOK\" node \"$HERE/scripts/build-number.mjs\" \"$BOOK\" ${LEGACY_BOOK:+\"$LEGACY_BOOK\"})}\"\n# 包标识改名前是 dev.ash.mac：已装的旧版怎么接到这一版，见 Sources/LegacyIdentity.swift 和 README「从 Ash.app 升级」。\nBUNDLE_ID=\"${NAVI_MAC_BUNDLE_ID:-${ASH_MAC_BUNDLE_ID:-}}\"\nBUNDLE_ID=\"${BUNDLE_ID:-dev.navi.mac}\"\n\n# 更新源：release.json 里放 appcast 的那个仓库（feedRepo，不是放安装包的 releaseRepo）→\n"
      },
      {
        "from": "  console.log(c.feedRepo, c.feedBranch || \"main\", c.appcastPath || \"appcast.xml\", c.publicKey || \"-\");' \"$HERE/release.json\")\"\nread -r FEED_REPO FEED_BRANCH FEED_APPCAST RELEASE_KEY <<< \"$RELEASE_CONFIG\"\nFEED_URL=\"${NAVI_MAC_FEED_URL:-https://raw.githubusercontent.com/$FEED_REPO/$FEED_BRANCH/$FEED_APPCAST}\"\nED_KEY=\"${NAVI_MAC_ED_PUBLIC_KEY:-$RELEASE_KEY}\"\n[[ \"$ED_KEY\" == \"-\" ]] && ED_KEY=\"\"\n\n",
        "to": "  console.log(c.feedRepo, c.feedBranch || \"main\", c.appcastPath || \"appcast.xml\", c.publicKey || \"-\");' \"$HERE/release.json\")\"\nread -r FEED_REPO FEED_BRANCH FEED_APPCAST RELEASE_KEY <<< \"$RELEASE_CONFIG\"\nFEED_URL=\"${NAVI_MAC_FEED_URL:-${ASH_MAC_FEED_URL:-}}\"\nFEED_URL=\"${FEED_URL:-https://raw.githubusercontent.com/$FEED_REPO/$FEED_BRANCH/$FEED_APPCAST}\"\nED_KEY=\"${NAVI_MAC_ED_PUBLIC_KEY:-${ASH_MAC_ED_PUBLIC_KEY:-}}\"\nED_KEY=\"${ED_KEY:-$RELEASE_KEY}\"\n[[ \"$ED_KEY\" == \"-\" ]] && ED_KEY=\"\"\n\n"
      }
    ]
  },
  {
    "file": "desktop/macos/scripts/build-number.mjs",
    "why": "旧环境变量兼容：发版脚本经 readEnv 读两代",
    "marker": "readEnv(process.env, \"NAVI_MAC_",
    "hunks": [
      {
        "from": "// 这一次不比它大就在它上面加一。更新器只认 CFBundleVersion 的先后，撞号或倒退都会让它不更新。\nimport { readFileSync, writeFileSync } from \"node:fs\";\n\nconst [book, legacyBook] = process.argv.slice(2);\n",
        "to": "// 这一次不比它大就在它上面加一。更新器只认 CFBundleVersion 的先后，撞号或倒退都会让它不更新。\nimport { readFileSync, writeFileSync } from \"node:fs\";\nimport { readEnv } from \"../../../scripts/env.mjs\";\n\nconst [book, legacyBook] = process.argv.slice(2);\n"
      },
      {
        "from": "const after = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);\n\nconst clock = process.env.NAVI_MAC_BUILD_CLOCK ? new Date(process.env.NAVI_MAC_BUILD_CLOCK) : new Date();\nconst pad = (n, width = 2) => String(n).padStart(width, \"0\");\nconst stamp = `${clock.getUTCFullYear()}${pad(clock.getUTCMonth() + 1)}${pad(clock.getUTCDate())}`\n",
        "to": "const after = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);\n\nconst clockOverride = readEnv(process.env, \"NAVI_MAC_BUILD_CLOCK\");\nconst clock = clockOverride ? new Date(clockOverride) : new Date();\nconst pad = (n, width = 2) => String(n).padStart(width, \"0\");\nconst stamp = `${clock.getUTCFullYear()}${pad(clock.getUTCMonth() + 1)}${pad(clock.getUTCDate())}`\n"
      }
    ]
  },
  {
    "file": "desktop/macos/scripts/bundle-runtime.mjs",
    "why": "旧环境变量兼容：发版脚本经 readEnv 读两代",
    "marker": "readEnv(process.env, \"NAVI_MAC_",
    "hunks": [
      {
        "from": "import { dirname, join, resolve } from \"node:path\";\nimport { fileURLToPath } from \"node:url\";\n\n// 升级 node：改这三行，sha256 取 https://nodejs.org/dist/<版本>/SHASUMS256.txt 里对应那一行。\n",
        "to": "import { dirname, join, resolve } from \"node:path\";\nimport { fileURLToPath } from \"node:url\";\nimport { readEnv } from \"../../../scripts/env.mjs\";\n\n// 升级 node：改这三行，sha256 取 https://nodejs.org/dist/<版本>/SHASUMS256.txt 里对应那一行。\n"
      },
      {
        "from": "  process.exit(2);\n}\nconst CACHE = resolve(process.env.NAVI_MAC_CACHE || join(HERE, \"..\", \"build\", \"cache\"));\nconst APP = join(resolve(resources), \"app\");\nconst WORKSPACES = [\"shared\", \"server\", \"web\", \"mcp\"];\n",
        "to": "  process.exit(2);\n}\nconst CACHE = resolve(readEnv(process.env, \"NAVI_MAC_CACHE\") || join(HERE, \"..\", \"build\", \"cache\"));\nconst APP = join(resolve(resources), \"app\");\nconst WORKSPACES = [\"shared\", \"server\", \"web\", \"mcp\"];\n"
      },
      {
        "from": "\n// ── 1. 产物 ────────────────────────────────────────────────────────────────\nif (process.env.NAVI_MAC_SKIP_BUILD !== \"1\") {\n  say(\"▶ npm run build\");\n  run(\"npm\", [\"run\", \"build\"], { cwd: REPO });\n",
        "to": "\n// ── 1. 产物 ────────────────────────────────────────────────────────────────\nif (readEnv(process.env, \"NAVI_MAC_SKIP_BUILD\") !== \"1\") {\n  say(\"▶ npm run build\");\n  run(\"npm\", [\"run\", \"build\"], { cwd: REPO });\n"
      }
    ]
  },
  {
    "file": "desktop/macos/scripts/github.mjs",
    "why": "旧环境变量兼容：发版脚本经 readEnv 读两代",
    "marker": "readEnv(process.env, \"NAVI_MAC_",
    "hunks": [
      {
        "from": "import { readFileSync, statSync } from \"node:fs\";\nimport { basename, extname } from \"node:path\";\n\n// NAVI_MAC_GITHUB_API 只给回归测试指向一个本地假的 GitHub。\nconst API = process.env.NAVI_MAC_GITHUB_API || \"https://api.github.com\";\n\n/** 按顺序找：GH_TOKEN / GITHUB_TOKEN → `gh auth token` → git 凭证助手里 github.com 那一条。 */\n",
        "to": "import { readFileSync, statSync } from \"node:fs\";\nimport { basename, extname } from \"node:path\";\nimport { readEnv } from \"../../../scripts/env.mjs\";\n\n// NAVI_MAC_GITHUB_API 只给回归测试指向一个本地假的 GitHub。\nconst API = readEnv(process.env, \"NAVI_MAC_GITHUB_API\") || \"https://api.github.com\";\n\n/** 按顺序找：GH_TOKEN / GITHUB_TOKEN → `gh auth token` → git 凭证助手里 github.com 那一条。 */\n"
      }
    ]
  },
  {
    "file": "desktop/macos/scripts/release.mjs",
    "why": "旧环境变量兼容：发版脚本经 readEnv 读两代",
    "marker": "readEnv(process.env, \"NAVI_MAC_",
    "hunks": [
      {
        "from": "import { fileURLToPath } from \"node:url\";\nimport { parseArgs } from \"node:util\";\nimport { compareVersions, latestVersion, parseItems, previousCommit, renderAppcast, renderInformationalItem, renderItem } from \"./appcast.mjs\";\nimport { commitLink, LINK_COMMIT_PREFIX } from \"./download-link.mjs\";\n",
        "to": "import { fileURLToPath } from \"node:url\";\nimport { parseArgs } from \"node:util\";\nimport { readEnv } from \"../../../scripts/env.mjs\";\nimport { compareVersions, latestVersion, parseItems, previousCommit, renderAppcast, renderInformationalItem, renderItem } from \"./appcast.mjs\";\nimport { commitLink, LINK_COMMIT_PREFIX } from \"./download-link.mjs\";\n"
      },
      {
        "from": "const REPO = resolve(MAC, \"../..\");\n// NAVI_MAC_RELEASE_CONFIG 只给回归测试换一份发版配置（配合 github.mjs 的 NAVI_MAC_GITHUB_API 演练正式发版）。\nconst CONFIG_PATH = process.env.NAVI_MAC_RELEASE_CONFIG || join(MAC, \"release.json\");\n// NAVI_MAC_README 同理：换掉发完要改下载链接的那份 README（测试指向一个临时仓库）。\nconst README = process.env.NAVI_MAC_README || join(REPO, \"README.md\");\n\nconst say = (line) => process.stdout.write(`${line}\\n`);\n",
        "to": "const REPO = resolve(MAC, \"../..\");\n// NAVI_MAC_RELEASE_CONFIG 只给回归测试换一份发版配置（配合 github.mjs 的 NAVI_MAC_GITHUB_API 演练正式发版）。\nconst CONFIG_PATH = readEnv(process.env, \"NAVI_MAC_RELEASE_CONFIG\") || join(MAC, \"release.json\");\n// NAVI_MAC_README 同理：换掉发完要改下载链接的那份 README（测试指向一个临时仓库）。\nconst README = readEnv(process.env, \"NAVI_MAC_README\") || join(REPO, \"README.md\");\n\nconst say = (line) => process.stdout.write(`${line}\\n`);\n"
      },
      {
        "from": "  const tag = `${local ? \"v\" : config.tagPrefix}${shortVersion}-${version}`;\n  // NAVI_MAC_RELEASE_ARTIFACTS 只给回归测试换地方，免得演练的包落进 build/releases。\n  const artifacts = join(process.env.NAVI_MAC_RELEASE_ARTIFACTS || join(MAC, \"build\", \"releases\"), tag);\n  const dmg = join(artifacts, `Navi-${shortVersion}-${version}.dmg`);\n  const source = `${dmg}.source`;\n",
        "to": "  const tag = `${local ? \"v\" : config.tagPrefix}${shortVersion}-${version}`;\n  // NAVI_MAC_RELEASE_ARTIFACTS 只给回归测试换地方，免得演练的包落进 build/releases。\n  const artifacts = join(readEnv(process.env, \"NAVI_MAC_RELEASE_ARTIFACTS\") || join(MAC, \"build\", \"releases\"), tag);\n  const dmg = join(artifacts, `Navi-${shortVersion}-${version}.dmg`);\n  const source = `${dmg}.source`;\n"
      }
    ]
  },
  {
    "file": "desktop/macos/scripts/sparkle.mjs",
    "why": "旧环境变量兼容：发版脚本经 readEnv 读两代",
    "marker": "readEnv(process.env, \"NAVI_MAC_",
    "hunks": [
      {
        "from": "import { dirname, join, resolve } from \"node:path\";\nimport { fileURLToPath } from \"node:url\";\n\nexport const SPARKLE_VERSION = \"2.10.1\";\n",
        "to": "import { dirname, join, resolve } from \"node:path\";\nimport { fileURLToPath } from \"node:url\";\nimport { readEnv } from \"../../../scripts/env.mjs\";\n\nexport const SPARKLE_VERSION = \"2.10.1\";\n"
      },
      {
        "from": "\n/** 确保缓存里有解开的 Sparkle，返回它的目录（里面有 Sparkle.framework 和 bin/）。 */\nexport async function ensureSparkle(cache = resolve(process.env.NAVI_MAC_CACHE || join(HERE, \"..\", \"build\", \"cache\"))) {\n  const home = join(cache, `Sparkle-${SPARKLE_VERSION}`);\n  if (existsSync(join(home, \"bin\", \"sign_update\")) && existsSync(join(home, \"Sparkle.framework\"))) return home;\n",
        "to": "\n/** 确保缓存里有解开的 Sparkle，返回它的目录（里面有 Sparkle.framework 和 bin/）。 */\nexport async function ensureSparkle(cache = resolve(readEnv(process.env, \"NAVI_MAC_CACHE\") || join(HERE, \"..\", \"build\", \"cache\"))) {\n  const home = join(cache, `Sparkle-${SPARKLE_VERSION}`);\n  if (existsSync(join(home, \"bin\", \"sign_update\")) && existsSync(join(home, \"Sparkle.framework\"))) return home;\n"
      }
    ]
  },
  {
    "file": "docs/win-remote.md",
    "why": "选对端项目的新规矩写进使用说明",
    "marker": "不会退到列表第一个",
    "hunks": [
      {
        "from": "不带就是 401;在那台 Windows 上打开 Navi「设置 → 默认规则 → 远程访问」拿,或在它本机\n`curl http://127.0.0.1:4317/api/remote-access`)、`WIN_REMOTE_HOST`(默认 `http://192.168.1.187:4317`)、`WIN_REMOTE_SELF`(本机对外 IP,\n自动探测不准时用)、`WIN_REMOTE_PROJECT`(对端项目 id,自动按 `repoPath` 猜歪了时用;给了不存在的\nid 会把现有项目列出来)、`WIN_REMOTE_GIT_PORT`(钉死 git daemon 端口,默认每次现挑一个空闲的)、\n`WIN_REMOTE_WORKSPACE`(换个对端目录,默认 `.worktrees/win-remote`;**四个子命令一律跟着它走** ——\nsync 检出、exec 的 cwd、test 的 cwd、doctor 的探针都取同一个来源,不会出现「同步 A、测 B」)、\n",
        "to": "不带就是 401;在那台 Windows 上打开 Navi「设置 → 默认规则 → 远程访问」拿,或在它本机\n`curl http://127.0.0.1:4317/api/remote-access`)、`WIN_REMOTE_HOST`(默认 `http://192.168.1.187:4317`)、`WIN_REMOTE_SELF`(本机对外 IP,\n自动探测不准时用)、`WIN_REMOTE_PROJECT`(对端项目 id。不给就按 `repoPath` 的目录名认本仓库,新旧名都认,\n认不出或认出好几个就拒绝并列出现有项目,不会退到列表第一个;给了不存在的 id 同样列出来)、`WIN_REMOTE_GIT_PORT`(钉死 git daemon 端口,默认每次现挑一个空闲的)、\n`WIN_REMOTE_WORKSPACE`(换个对端目录,默认 `.worktrees/win-remote`;**四个子命令一律跟着它走** ——\nsync 检出、exec 的 cwd、test 的 cwd、doctor 的探针都取同一个来源,不会出现「同步 A、测 B」)、\n"
      }
    ]
  },
  {
    "file": "package.json",
    "why": "win-remote 选项目的回归挂进验收命令的第三步",
    "marker": "test-win-remote-project.mjs",
    "hunks": [
      {
        "from": "\"test:accept-scripts\": \"node scripts/test-codex-mcp-setup.mjs && ",
        "to": "\"test:accept-scripts\": \"node scripts/test-codex-mcp-setup.mjs && node scripts/test-win-remote-project.mjs && "
      }
    ]
  },
  {
    "file": "package.json",
    "why": "改名脚本新建落点的回归挂进验收命令的第三步",
    "marker": "test-rename-navi.mjs",
    "hunks": [
      {
        "from": "node scripts/test-win-remote-project.mjs && ",
        "to": "node scripts/test-win-remote-project.mjs && node scripts/test-rename-navi.mjs && "
      }
    ]
  },
  {
    "file": "scripts/legacy-names.mjs",
    "why": "旧名登记处的镜像跟着添同一项",
    "marker": "LEGACY_REPO_DIR_NAMES =",
    "hunks": [
      {
        "from": "export const LEGACY_ENV_PREFIXES = [\"ASH_\", \"HARNESS_\"];\nexport const LEGACY_MCP_SERVER_NAMES = [\"ash\", \"harness\"];\nexport const LEGACY_TASK_BRANCH_PREFIXES = [\"ash/\", \"harness/\"];\nexport const LEGACY_ACCEPT_TAG_PREFIX = \"ash-accepted/\";\n",
        "to": "export const LEGACY_ENV_PREFIXES = [\"ASH_\", \"HARNESS_\"];\nexport const LEGACY_MCP_SERVER_NAMES = [\"ash\", \"harness\"];\nexport const LEGACY_REPO_DIR_NAMES = [\"ash\", \"harness\"];\nexport const LEGACY_TASK_BRANCH_PREFIXES = [\"ash/\", \"harness/\"];\nexport const LEGACY_ACCEPT_TAG_PREFIX = \"ash-accepted/\";\n"
      }
    ]
  },
  {
    "file": "scripts/test-accept-test.mjs",
    "why": "夹具按 import 闭包复制脚本（入口依赖了 env.mjs / legacy-names.mjs，手抄清单漏了它们）；直接跑执行器时宿主带进来的旧名库与数据目录不漏给叶子的回归",
    "marker": "直接跑执行器（",
    "hunks": [
      {
        "from": "import { fileURLToPath } from \"node:url\";\nimport { test } from \"node:test\";\n\nconst repo = fileURLToPath(new URL(\"..\", import.meta.url));\n",
        "to": "import { fileURLToPath } from \"node:url\";\nimport { test } from \"node:test\";\nimport { LEGACY_ENV_PREFIXES } from \"./legacy-names.mjs\";\n\nconst repo = fileURLToPath(new URL(\"..\", import.meta.url));\n"
      },
      {
        "from": "const parallelOnly = parallel ? {} : { skip: \"Windows 走串行 npm，没有并行池子\" };\nconst SERIAL = { NAVI_TEST_RUNNER: \"serial\" };\n\n// 夹具长成真实仓库的形状：根包声明 workspaces，后端那一步的链住在 server 子包、前端那一步\n",
        "to": "const parallelOnly = parallel ? {} : { skip: \"Windows 走串行 npm，没有并行池子\" };\nconst SERIAL = { NAVI_TEST_RUNNER: \"serial\" };\n// 指向数据的那几个变量，各代名字都算（旧前缀取自旧名登记处）。\nconst STORAGE_KEY = new RegExp(`^(?:NAVI_|${LEGACY_ENV_PREFIXES.join(\"|\")})(?:DB|RUNS_DIR|DATA_DIR)$`, \"i\");\n\n// 入口顺着相对 import 拉进来的全部脚本：手抄清单会在入口多依赖一个文件时漏掉它，夹具里一 import 就找不到模块。\nfunction importClosure(entry) {\n  const seen = new Set();\n  const visit = (name) => {\n    if (seen.has(name)) return;\n    seen.add(name);\n    for (const [, dep] of readFileSync(join(repo, \"scripts\", name), \"utf8\").matchAll(/^import [^;]*?from \"\\.\\/([^\"]+)\";/gm)) visit(dep);\n  };\n  visit(entry);\n  return [...seen];\n}\n\n// 夹具长成真实仓库的形状：根包声明 workspaces，后端那一步的链住在 server 子包、前端那一步\n"
      },
      {
        "from": "  context.after(() => rmSync(root, { recursive: true, force: true }));\n  for (const dir of [\"scripts\", \"server\", \"web\", \"mobile\"]) mkdirSync(join(root, dir));\n  for (const name of [\"accept-test.mjs\", \"test-runner.mjs\", \"test-runner-processes.mjs\", \"npm.mjs\"]) {\n    cpSync(join(repo, \"scripts\", name), join(root, \"scripts\", name));\n  }\n  // 第三步的链住在根包：一条根目录下的脚本，再用 `npm --prefix` 进到一个**不是** workspace 的包（mobile 的形状）。\n  writeFileSync(join(root, \"package.json\"), JSON.stringify({\n",
        "to": "  context.after(() => rmSync(root, { recursive: true, force: true }));\n  for (const dir of [\"scripts\", \"server\", \"web\", \"mobile\"]) mkdirSync(join(root, dir));\n  for (const name of importClosure(\"accept-test.mjs\")) cpSync(join(repo, \"scripts\", name), join(root, \"scripts\", name));\n  // 第三步的链住在根包：一条根目录下的脚本，再用 `npm --prefix` 进到一个**不是** workspace 的包（mobile 的形状）。\n  writeFileSync(join(root, \"package.json\"), JSON.stringify({\n"
      },
      {
        "from": "        chromeTmp: process.env.MAC_CHROMIUM_TMPDIR ?? null,\n        tsxCache: (() => { try { return readlinkSync(join(tmpdir(), \\`tsx-\\${process.geteuid?.() ?? userInfo().username}\\`)); } catch { return null; } })(),\n        environment: Object.keys(process.env).filter((key) => /^NAVI_(?:DB|RUNS_DIR)$/i.test(key)) }));\n    console.log(${JSON.stringify(stdout)});\n    console.error(${JSON.stringify(`${stdout}_STDERR`)});\n",
        "to": "        chromeTmp: process.env.MAC_CHROMIUM_TMPDIR ?? null,\n        tsxCache: (() => { try { return readlinkSync(join(tmpdir(), \\`tsx-\\${process.geteuid?.() ?? userInfo().username}\\`)); } catch { return null; } })(),\n        environment: Object.keys(process.env).filter((key) => /^NAVI_(?:DB|RUNS_DIR)$/i.test(key)),\n        storage: Object.fromEntries(Object.entries(process.env).filter(([key]) => new RegExp(${JSON.stringify(STORAGE_KEY.source)}, \"i\").test(key))) }));\n    console.log(${JSON.stringify(stdout)});\n    console.error(${JSON.stringify(`${stdout}_STDERR`)});\n"
      },
      {
        "from": "});\n\ntest(\"依赖缺失导致测试无法启动时拒绝放行\", (context) => {\n  const result = run(fixture(context, { web: \"node missing-regression.mjs\" }));\n",
        "to": "});\n\n// 直接跑执行器（npm run test:web 这类，不经验收入口）：宿主带进来的改名前旧名（ASH_DATA_DIR 等）同样不漏给\n// 叶子 —— 漏下去的话，叶子里新写的 NAVI_DATA_DIR 和它同时出现、值不同，读的那头拒绝启动。\nfor (const [label, mode] of [[\"并行\", {}], [\"串行\", SERIAL]]) {\n  test(`直接跑执行器（${label}）：宿主带进来的各代库与数据目录不漏给叶子`, (context) => {\n    const root = fixture(context);\n    const host = join(root, \"host-data\");\n    const OLD = LEGACY_ENV_PREFIXES[0];\n    // 真实路径：执行器按 import.meta.url 认「是不是被直接跑的」，macOS 的临时目录在 /var → /private/var 软链后面。\n    const result = spawnSync(process.execPath, [join(realpathSync(root), \"scripts\", \"test-runner.mjs\"), \"server\", \"test:accept\"], {\n      cwd: tmpdir(), encoding: \"utf8\", timeout: 60_000,\n      env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root, ...mode,\n        [`${OLD}DATA_DIR`]: host, [`${OLD}DB`]: join(root, \"host.db\"), [`${OLD}RUNS_DIR`]: join(root, \"host-runs\") },\n    });\n    assert.equal(result.status, 0, result.stdout + result.stderr);\n    assert.match(result.stdout, /server test:accept 全部通过/);\n    for (const name of [\"backend\", \"more\"]) {\n      const { storage } = seen(root, name);\n      assert.deepEqual(Object.keys(storage), [\"NAVI_DATA_DIR\"], `${name} 看见了宿主的库或数据目录：${JSON.stringify(storage)}`);\n      assert.notEqual(storage.NAVI_DATA_DIR, host);\n    }\n  });\n}\n\ntest(\"依赖缺失导致测试无法启动时拒绝放行\", (context) => {\n  const result = run(fixture(context, { web: \"node missing-regression.mjs\" }));\n"
      }
    ]
  },
  {
    "file": "scripts/test-macos-client.mjs",
    "why": "旧环境变量兼容的回归：只给旧名、新旧都给、新名为空、两代打架",
    "marker": "pre-rename environment names",
    "hunks": [
      {
        "from": "import { testInstanceGuard } from \"./macos-client-guard.mjs\";\nimport { testInstall } from \"./macos-client-install.mjs\";\n\nassert.equal(process.platform, \"darwin\", \"macOS-only regression\");\n",
        "to": "import { testInstanceGuard } from \"./macos-client-guard.mjs\";\nimport { testInstall } from \"./macos-client-install.mjs\";\nimport { LEGACY_ENV_PREFIXES } from \"./legacy-names.mjs\";\n\nassert.equal(process.platform, \"darwin\", \"macOS-only regression\");\n"
      },
      {
        "from": "}\n\nfunction launch(command, args, env = {}) {\n  const base = { ...process.env };\n  for (const key of [\"NAVI_DATA_DIR\", \"NAVI_URL\", \"NAVI_LOCAL_ONLY\", \"PORT\"]) delete base[key];\n  const child = spawn(command, args, { env: { ...base, ...env }, stdio: [\"ignore\", \"pipe\", \"pipe\"] });\n  children.add(child);\n",
        "to": "}\n\n// app 的配置变量，两代名字都算。旧前缀取自旧名登记处：批量改名不会把这里的旧名也换掉。\nconst OLD = LEGACY_ENV_PREFIXES[0];\nconst APP_ENV = new RegExp(`^(?:(?:NAVI_|${OLD})(?:DATA_DIR|URL|LOCAL_ONLY|MAC_\\\\w+)|PORT)$`);\n\nfunction launch(command, args, env = {}) {\n  // 跑测试的这个进程自己带着的配置（两代名字都算：app 新旧都认）一概不往下传，只认这里给的。\n  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !APP_ENV.test(key)));\n  const child = spawn(command, args, { env: { ...base, ...env }, stdio: [\"ignore\", \"pipe\", \"pipe\"] });\n  children.add(child);\n"
      },
      {
        "from": "    NAVI_MAC_WINDOW_PORT: String(windowPort),\n  };\n\n  // ── 下载事务 ──\n",
        "to": "    NAVI_MAC_WINDOW_PORT: String(windowPort),\n  };\n\n  // ── 环境变量：改名前的旧名照样认、新名优先；指向数据的两代打架就不打开 ──\n  const config = async (vars) => {\n    const r = await launch(binary, [\"config\"], vars).done;\n    return { status: r.status, values: Object.fromEntries(r.output.trim().split(\"\\n\").map((line) => line.split(/=(.*)/s).slice(0, 2))), output: r.output };\n  };\n  const legacyData = join(temporary, \"legacy-data\");\n  const legacyOnly = await config({ [`${OLD}URL`]: \"http://192.0.2.123:14977\", [`${OLD}DATA_DIR`]: legacyData, [`${OLD}MAC_WINDOW_PORT`]: \"44997\",\n    [`${OLD}MAC_RUNTIME`]: runtime, [`${OLD}MAC_DOWNLOAD_JOURNAL`]: journal });\n  assert.equal(legacyOnly.status, 0, legacyOnly.output);\n  assert.deepEqual(legacyOnly.values, { url: \"http://192.0.2.123:14977\", data: legacyData, window: \"44997\", runtime, journal },\n    \"a launch configured with the pre-rename names keeps pointing at the same service, data root, port, runtime and journal\");\n  const both = await config({ NAVI_URL: env.NAVI_URL, [`${OLD}URL`]: env.NAVI_URL, NAVI_DATA_DIR: data, [`${OLD}DATA_DIR`]: data,\n    NAVI_MAC_WINDOW_PORT: String(windowPort), [`${OLD}MAC_WINDOW_PORT`]: \"44997\", [`${OLD}MAC_RUNTIME`]: join(temporary, \"elsewhere\"), NAVI_MAC_RUNTIME: runtime });\n  assert.equal(both.status, 0, both.output);\n  assert.deepEqual([both.values.url, both.values.data, both.values.window, both.values.runtime], [env.NAVI_URL, data, String(windowPort), runtime],\n    \"the new name wins when both generations are set\");\n  const emptyNew = await config({ NAVI_DATA_DIR: \"\", [`${OLD}DATA_DIR`]: legacyData });\n  assert.equal(emptyNew.values.data, legacyData, \"an empty new name counts as unset\");\n  for (const [name, a, b] of [[\"DATA_DIR\", data, legacyData], [\"URL\", env.NAVI_URL, \"http://192.0.2.123:14977\"]]) {\n    const clash = await config({ [`NAVI_${name}`]: a, [`${OLD}${name}`]: b });\n    assert.equal(clash.status, 1, clash.output);\n    assert.match(clash.output, new RegExp(`^CONFLICT NAVI_${name}=.* ${OLD}${name}=`), `NAVI_${name} and ${OLD}${name} pointing at different places refuse to open`);\n  }\n  console.log(\"PASS: pre-rename environment names (URL / data root / mac test hooks) still configure the app; new names win; conflicting data roots or services refuse to open\");\n\n  // ── 下载事务 ──\n"
      }
    ]
  },
  {
    "file": "scripts/test-macos-update.mjs",
    "why": "测试驱动不把外面继承来的两代环境变量漏给被测进程",
    "marker": "const inherited = Object.fromEntries(",
    "hunks": [
      {
        "from": "import { join } from \"node:path\";\nimport { fileURLToPath } from \"node:url\";\n\nassert.equal(process.platform, \"darwin\", \"macOS-only regression\");\n",
        "to": "import { join } from \"node:path\";\nimport { fileURLToPath } from \"node:url\";\nimport { LEGACY_ENV_PREFIXES } from \"./legacy-names.mjs\";\n\nassert.equal(process.platform, \"darwin\", \"macOS-only regression\");\n"
      },
      {
        "from": "const runtime = join(temporary, \"no-runtime\");\nconst windowPort = await freePort();\nconst env = { ...process.env, NAVI_URL: `http://127.0.0.1:${port}`, NAVI_DATA_DIR: data, NAVI_MAC_RUNTIME: runtime,\n  NAVI_MAC_WINDOW_PORT: String(windowPort) };\nconst impactFile = join(temporary, \"impact.json\");\n",
        "to": "const runtime = join(temporary, \"no-runtime\");\nconst windowPort = await freePort();\n// 跑测试的这个进程自己带着的 app 配置（两代名字都算）不往下传。\nconst inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !new RegExp(`^(?:NAVI_|${LEGACY_ENV_PREFIXES[0]})(?:DATA_DIR|URL|LOCAL_ONLY|MAC_\\\\w+)$`).test(key)));\nconst env = { ...inherited, NAVI_URL: `http://127.0.0.1:${port}`, NAVI_DATA_DIR: data, NAVI_MAC_RUNTIME: runtime,\n  NAVI_MAC_WINDOW_PORT: String(windowPort) };\nconst impactFile = join(temporary, \"impact.json\");\n"
      }
    ]
  },
  {
    "file": "scripts/test-runner.mjs",
    "why": "旧环境变量兼容：测试运行器的并行数/串行开关两代都认；叶子环境擦掉宿主带进来的各代库与数据目录，自己的临时数据目录用 setEnv 写新名（只写新名会和继承来的 ASH_DATA_DIR 打架）",
    "marker": "function leafEnv(",
    "hunks": [
      {
        "from": "import { delimiter, dirname, join, relative, resolve } from \"node:path\";\nimport { fileURLToPath, pathToFileURL } from \"node:url\";\nimport { NPM, NPM_SPAWN_OPTS } from \"./npm.mjs\";\nimport { descendants, marked, pause, signal } from \"./test-runner-processes.mjs\";\n",
        "to": "import { delimiter, dirname, join, relative, resolve } from \"node:path\";\nimport { fileURLToPath, pathToFileURL } from \"node:url\";\nimport { clearEnv, readEnv, setEnv } from \"./env.mjs\";\nimport { NPM, NPM_SPAWN_OPTS } from \"./npm.mjs\";\nimport { descendants, marked, pause, signal } from \"./test-runner-processes.mjs\";\n"
      },
      {
        "from": "const LEAF_ENV = { NAVI_TEST_NO_MODEL_PROBE: \"1\" };\n\n// 系统临时目录认的变量。`MAC_CHROMIUM_TMPDIR`：macOS 上的 Chrome 不看 TMPDIR，单例套接字的目录\n// （`com.google.Chrome.XXXXXX`）按它找、没有就落到系统默认的临时目录；测试关浏览器是直接杀的，\n",
        "to": "const LEAF_ENV = { NAVI_TEST_NO_MODEL_PROBE: \"1\" };\n\n// 叶子的环境（并行、串行两条路都从这里出）：宿主带进来的库、运行目录、数据目录不往下传，各代名字一起擦\n// （同验收入口 accept-test.mjs 和回归 worker）；这一条自己的临时目录用 setEnv 写 —— 只写新名、不擦旧名的话，\n// 从外面继承来的 ASH_DATA_DIR 和新写的 NAVI_DATA_DIR 同时出现、值又不同，读的那头（readStorageEnv）拒绝启动。\n// 叶子里的测试自己再写 NAVI_DB 之类，也就不会撞上一个继承来的旧名。\nconst HOST_STORAGE_ENV = [\"NAVI_DB\", \"NAVI_RUNS_DIR\", \"NAVI_DATA_DIR\"];\nfunction leafEnv(base, scratch) {\n  const env = { ...base, ...LEAF_ENV };\n  for (const name of HOST_STORAGE_ENV) clearEnv(env, name);\n  for (const [name, value] of Object.entries(scratch)) {\n    if (name.startsWith(\"NAVI_\")) setEnv(env, name, value);\n    else env[name] = value;\n  }\n  return env;\n}\n\n// 系统临时目录认的变量。`MAC_CHROMIUM_TMPDIR`：macOS 上的 Chrome 不看 TMPDIR，单例套接字的目录\n// （`com.google.Chrome.XXXXXX`）按它找、没有就落到系统默认的临时目录；测试关浏览器是直接杀的，\n"
      },
      {
        "from": " */\nexport async function runSteps(repo, steps, { jobs = defaultJobs(), env = process.env, log = console.log } = {}) {\n  if (process.platform === \"win32\" || env.NAVI_TEST_RUNNER === \"serial\") return runSequentially(repo, steps, env, log);\n  const queue = schedule(steps.flatMap((step, index) => expandChain(repo, step.workspace, step.script)\n    .map((leaf) => ({ ...leaf, step: index }))), readHistory());\n",
        "to": " */\nexport async function runSteps(repo, steps, { jobs = defaultJobs(), env = process.env, log = console.log } = {}) {\n  if (process.platform === \"win32\" || readEnv(env, \"NAVI_TEST_RUNNER\") === \"serial\") return runSequentially(repo, steps, env, log);\n  const queue = schedule(steps.flatMap((step, index) => expandChain(repo, step.workspace, step.script)\n    .map((leaf) => ({ ...leaf, step: index }))), readHistory());\n"
      },
      {
        "from": "          detached: true,\n          stdio: [\"ignore\", output, output],\n          env: { ...env, ...extra, [owner]: String(index), ...LEAF_ENV, ...data.env, npm_lifecycle_event: leaf.script, PATH: binPath(repo, leaf.cwd, env.PATH) },\n        });\n      } finally {\n",
        "to": "          detached: true,\n          stdio: [\"ignore\", output, output],\n          env: { ...leafEnv({ ...env, ...extra, [owner]: String(index) }, data.env), npm_lifecycle_event: leaf.script, PATH: binPath(repo, leaf.cwd, env.PATH) },\n        });\n      } finally {\n"
      },
      {
        "from": "      const args = step.workspace === \".\" ? [\"run\", step.script] : [\"-w\", step.workspace, \"run\", step.script];\n      const data = leafScratch(dataRoot, String(steps.indexOf(step)));\n      const result = spawnSync(NPM, args, { ...NPM_SPAWN_OPTS, cwd: repo, stdio: \"inherit\", env: { ...env, ...LEAF_ENV, ...data.env } });\n      if (result.error) log(`[test-runner] 无法启动 ${step.workspace} ${step.script}：${result.error.message}`);\n      if (result.signal) log(`[test-runner] ${step.workspace} ${step.script} 被信号 ${result.signal} 终止。`);\n",
        "to": "      const args = step.workspace === \".\" ? [\"run\", step.script] : [\"-w\", step.workspace, \"run\", step.script];\n      const data = leafScratch(dataRoot, String(steps.indexOf(step)));\n      const result = spawnSync(NPM, args, { ...NPM_SPAWN_OPTS, cwd: repo, stdio: \"inherit\", env: leafEnv(env, data.env) });\n      if (result.error) log(`[test-runner] 无法启动 ${step.workspace} ${step.script}：${result.error.message}`);\n      if (result.signal) log(`[test-runner] ${step.workspace} ${step.script} 被信号 ${result.signal} 终止。`);\n"
      },
      {
        "from": "\nexport function defaultJobs() {\n  const requested = Number(process.env.NAVI_TEST_JOBS);\n  if (Number.isInteger(requested) && requested > 0) return requested;\n  return Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2)));\n",
        "to": "\nexport function defaultJobs() {\n  const requested = Number(readEnv(process.env, \"NAVI_TEST_JOBS\"));\n  if (Number.isInteger(requested) && requested > 0) return requested;\n  return Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2)));\n"
      }
    ]
  },
  {
    "file": "scripts/test-win-remote-project.mjs",
    "why": "选对端项目的回归：旧目录名、新目录名、像而不是、认出两个、明确指定",
    "marker": "// win-remote 选对端项目：没指定时按目录名认本仓库（新旧名都认），认不出、认出好几个都拒绝，",
    "content": "// win-remote 选对端项目：没指定时按目录名认本仓库（新旧名都认），认不出、认出好几个都拒绝，\n// 绝不退到列表第一项 —— 选错了，同步和执行会在别人的仓库里干活，且不报错。\nimport assert from \"node:assert/strict\";\nimport { createServer } from \"node:http\";\nimport { LEGACY_REPO_DIR_NAMES } from \"./legacy-names.mjs\";\n\ndelete process.env.WIN_REMOTE_PROJECT;\ndelete process.env.WIN_REMOTE_KEY;\nconst { resolveProject } = await import(\"./win-remote/transport.mjs\");\n\nlet projects = [];\nconst server = createServer((req, res) => {\n  res.setHeader(\"content-type\", \"application/json\");\n  res.end(JSON.stringify(req.url === \"/api/projects\" ? projects : {}));\n});\nawait new Promise((r) => server.listen(0, \"127.0.0.1\", r));\nconst host = `http://127.0.0.1:${server.address().port}`;\nconst pick = async (list) => { projects = list; return resolveProject(host); };\n\nconst OLD = LEGACY_REPO_DIR_NAMES[0];\nconst notes = { id: \"notes\", repoPath: \"D:\\\\projects\\\\notes\" };\nconst oldCheckout = { id: \"self\", repoPath: `D:\\\\ai_workspace\\\\${OLD}` };\ntry {\n  assert.deepEqual(await pick([notes, oldCheckout]), oldCheckout, \"别的项目排在前面、本仓库还是旧目录名：照样认出本仓库\");\n  const fresh = { id: \"fresh\", repoPath: \"C:\\\\code\\\\navi\" };\n  assert.deepEqual(await pick([notes, fresh]), fresh, \"新目录名\");\n  const unix = { id: \"unix\", repoPath: `/home/u/code/${LEGACY_REPO_DIR_NAMES[1]}/` };\n  assert.deepEqual(await pick([notes, unix]), unix, \"正斜杠、结尾带斜杠的路径按最后一段认\");\n\n  const lookalike = { id: \"nav\", repoPath: \"D:\\\\code\\\\navigation\" };\n  await assert.rejects(pick([notes, lookalike]), (e) => /认不出/.test(e.message) && /notes/.test(e.message) && /nav/.test(e.message),\n    \"名字里带着 navi 不算：认不出就拒绝并列出全部，不退到第一项\");\n  await assert.rejects(pick([notes, oldCheckout, fresh]), /好几个/, \"认出两个就拒绝，不替人挑\");\n\n  process.env.WIN_REMOTE_PROJECT = \"notes\";\n  assert.deepEqual(await pick([notes, oldCheckout]), notes, \"明确指定的照指定的来\");\n  delete process.env.WIN_REMOTE_PROJECT;\n  console.log(\"✓ win-remote 选对端项目：按目录名认两代、认不出或有歧义就拒绝、指定的优先\");\n} finally {\n  server.close();\n}\n"
  },
  {
    "file": "scripts/win-remote/transport.mjs",
    "why": "选对端项目按目录名认本仓库（新旧名都认），认不出或有歧义就拒绝，不退到列表第一项",
    "marker": "REPO_DIR_NAMES",
    "hunks": [
      {
        "from": "import { jobPreludeLines, jobAssignLine, jobCloseLine, killTreeLines } from \"./kill-tree.mjs\";\nimport { psq } from \"./ps.mjs\";\n\nconst DEFAULT_HOST = process.env.WIN_REMOTE_HOST ?? \"http://192.168.1.187:4317\";\n",
        "to": "import { jobPreludeLines, jobAssignLine, jobCloseLine, killTreeLines } from \"./kill-tree.mjs\";\nimport { psq } from \"./ps.mjs\";\nimport { LEGACY_REPO_DIR_NAMES } from \"../legacy-names.mjs\";\n\nconst DEFAULT_HOST = process.env.WIN_REMOTE_HOST ?? \"http://192.168.1.187:4317\";\n"
      },
      {
        "from": "}\n\n/** 找到对端 navi 里指向 navi 仓库自己的那个项目(终端会话必须挂在某个项目上)。 */\nexport async function resolveProject(host = DEFAULT_HOST, signal = controlSignal()) {\n  const projects = await api(\"/projects\", { signal }, host);\n",
        "to": "}\n\n// 本仓库检出的目录名,新名在前。改名不挪目录:那台机器上的检出还是旧名,几代都得认。\nconst REPO_DIR_NAMES = [\"navi\", ...LEGACY_REPO_DIR_NAMES];\nconst dirName = (repoPath) => (repoPath ?? \"\").split(/[\\\\/]+/).filter(Boolean).at(-1)?.toLowerCase() ?? \"\";\n\n/**\n * 找到对端 navi 里指向 navi 仓库自己的那个项目(终端会话必须挂在某个项目上)。\n *\n * 没指定就按目录名认,而且必须**恰好认出一个**:认不出或认出好几个都拒绝、列出全部让人指定。\n * 退到「列表第一项」等于把同步、执行搬进别人的仓库 —— 选错了不会报错,只会在错的目录里干活。\n */\nexport async function resolveProject(host = DEFAULT_HOST, signal = controlSignal()) {\n  const projects = await api(\"/projects\", { signal }, host);\n"
      },
      {
        "from": "    return { id: hit.id, repoPath: hit.repoPath };\n  }\n  const hit = projects.find((p) => /navi/i.test(p.repoPath ?? \"\")) ?? projects[0];\n  return { id: hit.id, repoPath: hit.repoPath };\n}\n\n",
        "to": "    return { id: hit.id, repoPath: hit.repoPath };\n  }\n  const hits = projects.filter((p) => REPO_DIR_NAMES.includes(dirName(p.repoPath)));\n  if (hits.length !== 1) {\n    throw new Error(\n      `${hits.length ? \"对端 Navi 里有好几个项目像是 Navi 仓库\" : \"对端 Navi 里认不出哪个项目是 Navi 仓库\"}`\n        + `(按目录名认:${REPO_DIR_NAMES.join(\" / \")}),用 WIN_REMOTE_PROJECT=<项目 id> 指定。现有项目:\\n`\n        + projects.map((p) => `  ${p.id}  ${p.repoPath ?? \"(无路径)\"}`).join(\"\\n\"),\n    );\n  }\n  return { id: hits[0].id, repoPath: hits[0].repoPath };\n}\n\n"
      }
    ]
  },
  {
    "file": "server/scripts/handoff-test-utils.ts",
    "why": "假对端报任务分支前缀：不报会被当成改名之前的对端、打包前就被拦下",
    "marker": "taskBranchPrefix: TASK_BRANCH_PREFIX",
    "hunks": [
      {
        "from": "import { writeFileSync } from \"node:fs\";\nimport { join } from \"node:path\";\nimport { IS_WINDOWS } from \"../src/platform.js\";\n\n",
        "to": "import { writeFileSync } from \"node:fs\";\nimport { join } from \"node:path\";\nimport { TASK_BRANCH_PREFIX } from \"@navi/shared/task-branch\";\nimport { IS_WINDOWS } from \"../src/platform.js\";\n\n"
      },
      {
        "from": "/**\n * 站在真对端前面的假对端(中间人/坏网关)。ping 与 refs 本地应答,**不报身份** ——\n * 源机会把它当旧版对端,这正是这类用例想要的:验的是网络语义,不是身份核对。\n * /import 交给 `onImport` 决定:掐断、原样转发、或者篡改转发结果。\n *\n",
        "to": "/**\n * 站在真对端前面的假对端(中间人/坏网关)。ping 与 refs 本地应答,**不报身份** ——\n * 源机会把它当没核过身份的对端,这正是这类用例想要的:验的是网络语义,不是身份核对。\n * 任务分支前缀照报:它前面站的是新版对端,不报就会被当成改名之前的版本、打包前就被拦下。\n * /import 交给 `onImport` 决定:掐断、原样转发、或者篡改转发结果。\n *\n"
      },
      {
        "from": "    };\n    if (req.url?.includes(\"/api/handoff/ping\")) {\n      json({ ok: true, service: \"navi\", host: opts.host, projects: [{ ...opts.project, isRepo: true }] });\n      return;\n    }\n",
        "to": "    };\n    if (req.url?.includes(\"/api/handoff/ping\")) {\n      json({ ok: true, service: \"navi\", host: opts.host, taskBranchPrefix: TASK_BRANCH_PREFIX, projects: [{ ...opts.project, isRepo: true }] });\n      return;\n    }\n"
      }
    ]
  },
  {
    "file": "shared/src/legacy-names.ts",
    "why": "旧名登记处添一项：仓库目录的旧名（改名不挪目录）",
    "marker": "LEGACY_REPO_DIR_NAMES =",
    "hunks": [
      {
        "from": " *  登记都由 setup / 注册执行器改写成新名、且升级前起的会话都已结束之后。 */\nexport const LEGACY_MCP_SERVER_NAMES = [\"ash\", \"harness\"] as const;\n\n/** 任务分支的旧前缀（`ash/<id8>`）。拆：升级前建的任务都已验收或清理、仓库里不再有这种分支之后。 */\n",
        "to": " *  登记都由 setup / 注册执行器改写成新名、且升级前起的会话都已结束之后。 */\nexport const LEGACY_MCP_SERVER_NAMES = [\"ash\", \"harness\"] as const;\n\n/** 仓库目录的旧名（用户机器上那份检出的文件夹名，如 Windows 真机 `D:\\ai_workspace\\ash`）：改名不挪目录，\n *  按目录认「哪个项目是本仓库」时两代都得认。拆：本地目录迁移把这些检出都挪成新名之后。 */\nexport const LEGACY_REPO_DIR_NAMES = [\"ash\", \"harness\"] as const;\n\n/** 任务分支的旧前缀（`ash/<id8>`）。拆：升级前建的任务都已验收或清理、仓库里不再有这种分支之后。 */\n"
      }
    ]
  }
];
