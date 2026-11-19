#!/usr/bin/env node
// 改名第 ⑤ 步：把仓库里剩下的、不跨边界的 ash 机械地换成 navi（包名与作用域、导入、文件名、符号、
// CSS 类名、注释、测试、文档）。跨边界的约定第 ③④ 步已经集中定义，旧名的兼容值在这里一律跳过。
//
//   node scripts/rename-navi.mjs            在当前检出上改（要求工作区干净，没加进 git 的文件也不许有），不提交：看过再自己提交
//   node scripts/rename-navi.mjs --dirty    有未提交的改动、没加进 git 的文件也照跑（失败时不能靠整仓重置回退）
//   node scripts/rename-navi.mjs --check    只看不改：还有要换的就列出来、退出码 1（重放后核对用）
//   node scripts/rename-navi.mjs --report   打出剩下的每一处 ash 和留下它的理由
//
// 交付结果 = 机械改名 + scripts/rename-navi-fixes.mjs 里的手写修复（旧环境变量兼容、被改名带坏的测试夹具）。
// 两层都在这一次运行里做完，--check 两层一起核：缺了手写修复的版本照样报「还有要改的」。
// 重新生成、合并之后要做的事、在途分支怎么跟上：见 docs/rename-navi.md。
//
// 为什么是脚本而不是一次性的提交：这一步碰上千个文件，和几乎所有在途分支冲突。验收前在最新的 main
// 上重跑一遍就是最新结果；在途分支在自己身上跑一遍再合，冲突只剩真正的语义冲突。脚本幂等：换完的
// 地方再也不含要换的词，留下的都由下面的规则认着。
//
// 认词按「词元」不按子串：hash、dashboard、bash、stash、flash、crash、lodash、slash 都不是它；
// 驼峰（`isAshMcp`）、下划线（`ASH_DB`）、连字符（`ash-presence`）切开之后整段是 ash 才算。
// 大小写跟着原词走：ash → navi、Ash → Navi、ASH → NAVI。
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXES } from "./rename-navi-fixes.mjs";
import { OPAQUE_WHY, renderReport } from "./rename-navi-report.mjs";
import { ancestorProblem, diskKind, identity, moveInRepo, writeInRepo } from "./rename-navi-fs.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SELF = "scripts/rename-navi.mjs";

// ── 认词 ──────────────────────────────────────────────────────────────────────────────────
// 前后都不能贴着字母数字（下划线、连字符、点、斜杠都是边界）；驼峰里的 `Ash` 前面可以是小写或数字。
// 字符串里的转义（`"\\nASH_URL"` 里的 `\\n`）和 URL 编码的斜杠（`%2Fash%2F`）也算边界。
const B = String.raw`(?:(?<![A-Za-z0-9])|(?<=\\[nrt]|%2[Ff]))`;
const TOKEN = new RegExp(String.raw`${B}ash(?![a-z0-9])|${B}Ash(?![a-z0-9])|(?<=[a-z0-9])Ash(?![a-z0-9])|${B}ASH(?![A-Za-z0-9])|${B}ASH(?=[A-Z][a-z])`, "g");
const CASES = { ash: "navi", Ash: "Navi", ASH: "NAVI" };
const HAS_TOKEN = new RegExp(TOKEN.source);
const renameText = (text) => text.replace(TOKEN, (m) => CASES[m]);

// ── 整份跳过 ──────────────────────────────────────────────────────────────────────────────
// 旧名的登记处：旧名只在这两份里出现（各自的文件头写着），整份不动。
// 规则文件：每一个字节的净增长都要用户口令（scripts/rule-guard.mjs），ash → navi 每处多一个字节，
// 所以由人逐条改写、保持字节不涨，脚本只在报告里列出来。
const REGISTRY_FILES = ["shared/src/legacy-names.ts", "scripts/legacy-names.mjs"];
// 改名自己的工具和交付文档：里面的旧名是规则和说明本身。
// 剩余清单是 --report 的输出：清单里不记它自己（生成时它正被写、内容是空的，记进去就和重新生成的对不上）。
// Windows 真机验证的记录和那台机器的升级操作单：写的是改名前那台机器上的事实（ASH_* 变量、ash/ 分支、旧锁文件名），换了就写错了。
const REMAINING = "docs/rename-navi-remaining.md";
const TOOLING_FILES = [SELF, "scripts/rename-navi-fixes.mjs", "scripts/rename-navi-report.mjs", "scripts/rename-navi-fs.mjs", "scripts/test-rename-navi.mjs", "docs/rename-navi.md", REMAINING, "docs/rename-navi-windows.md"];
const SKIP_FILES = new Set([...REGISTRY_FILES, ...TOOLING_FILES]);
const isRuleFile = (p) => /(^|\/)(CLAUDE|AGENTS)\.md$/.test(p) || p === "docs/incidents.md";
// 二进制格式的登记：正文不看（见 decode）。没登记的二进制会被当成「认不准的」整次拒绝，碰上了就在这里补扩展名。
const BINARY = /\.(png|jpe?g|gif|bmp|tiff?|avif|heic|icns|ico|webp|pdf|zip|gz|tgz|tar|bz2|xz|7z|dmg|ttf|otf|eot|woff2?|mp3|wav|ogg|webm|mp4|mov|wasm|node|so|dylib|dll|exe|bin|class|jar|pyc|db|sqlite3?)$|(^|\/)DS_Store$/i;

// ── 兼容值：在任何文件里都原样留下 ─────────────────────────────────────────────────────────
// 每条写明为什么留。值本身的定义与「什么时候能拆」在 shared/src/legacy-names.ts（及 web / 手机 / mac
// 各自的迁移代码）；这里认的是它们在别处的字面出现（测试的断言与输入、文档、注释、另一种语言写的同一个约定）。
const FROZEN = "冻结值（协议版本号/哈希盐/落库值/OS 对象名），当前版本照旧读写它，见 shared/src/legacy-names.ts";
const LEGACY_READ = "读旧写新的旧名：只在认旧数据的那一侧出现，见 shared/src/legacy-names.ts";
const GLOBAL_KEEP = [
  { id: "frozen-git-refs", why: FROZEN, re: /refs\/ash(?:-backup)?\//g },
  { id: "frozen-handoff", why: FROZEN, re: /ash-handoff-(?:enc-)?v1|ash-enc1|ash-im-bind:|ash-human-approval-v1/g },
  { id: "frozen-os-objects", why: FROZEN, re: /\.?ash-agent-(?:wrap\.cjs)?(?!attachments|guard|spawn)|ash-confine|ash-stdin-|ash-accept-gate-(?!prepare-|test-)/g },
  { id: "frozen-codex-relay", why: FROZEN, re: /ash_relay/g },
  { id: "frozen-git-identity", why: FROZEN + "；没填邮箱的人一直署这个域，合成的对比基准提交落款不变", re: /@ash\.local\b|ash@localhost|ash: 任务改动的对比基准/g },
  { id: "frozen-monitor-kind", why: FROZEN + "（哨兵出身 monitors.kind）",
    re: /\bkind\s*(?:===|!==|==|!=|:|=|<>)\s*(["'])ash\1/g,
    // 斜杠菜单的条目种类也叫 kind: "ash"，那是界面内部的分类，不是落库的哨兵出身，照常换。
    except: /(^|\/)(SlashMenu\.tsx|slashMatch\.ts|ReplyBox\.tsx|useReplySlash\.ts|test-slash-match\.mjs)$/ },
  // 同一行里跟 "claude" 并列的 "ash" 也是哨兵出身（`["ash", "claude"]`、`monitorRow(id, "ash"), monitorRow(id, "claude")`）。
  { id: "frozen-monitor-kind", why: FROZEN + "（哨兵出身 monitors.kind）",
    re: /(?:"ash"|'ash')(?=[^\n]*["']claude["'])|(?<=["']claude["'][^\n]*)(?:"ash"|'ash')/g },
  // monitors.kind 的断言与夹具（`normalizeMonitorDto(legacy).kind, "ash"`）。
  { id: "frozen-monitor-kind", why: FROZEN + "（哨兵出身 monitors.kind）", re: /(?<=\.kind,\s*)(?:"ash"|'ash')/g },
  { id: "legacy-persisted-text", why: "改名前落盘的旁注、门禁失败标签原文：网页按原文认老记录（shared/src/session-notes.ts、accept-gate.ts 的 LEGACY 常量与它们的测试）",
    re: /ash(?= 已经把这个失效的 id 清掉| 已清掉这条会话的恢复字段| 已["'`]| 重启,这次没跑完| 主动终止)/g },
  { id: "legacy-persisted-text", why: "认老记录的正则：界面现在说 Navi、改名前落盘的写 ash，两代都认", re: /(?<=\(\?:Navi\|)ash(?=\))/g },
  { id: "legacy-branch-prefix", why: "改名前的对端只认 ash/ 开头的任务分支（拒绝接力时说给用户的旧事实）", re: /(?<=只认 `?)ash(?=\/)/g },
  // shell 里「新名读不到退到旧名」的那一段（`${NAVI_MAC_X:-${ASH_MAC_X:-}}`）：旧名是兼容输入。
  { id: "legacy-env-fallback", why: "读环境变量时新名优先、退到改名前的旧名（脚本、mac 应用的启动与构建配置）", re: /(?<=:-\$\{)ASH_\w+(?=:-\})/g },
  { id: "legacy-lock-files", why: LEGACY_READ + "（互斥要横跨新旧两版：旧版只认这几个文件名）", re: /\.ash\.lock|\.ash-claim\.lock|\.ash-online\.|\.ash-deps-ready/g },
  { id: "legacy-markers", why: LEGACY_READ,
    re: /ash-accepted\/|ash-preview-annotation-v1|ash-workbench\b(?!-)|ash-worktree-backups\b(?!-)|ash-turn-progress-watch\/v2|ash\.sealedsnapshot|ash-claude-settings-|ash-track-|ash-claude-goal-(?!live-)|ash-goal-context|ash_int_|ash_session|ash_instance|ash-mcp\/host-setup/g },
  { id: "mac-legacy-app", why: "改名前的 mac 应用（Ash.app / dev.ash.mac / 登录项 dev.ash.server）：新版首次打开时按这些名字接班",
    re: /Ash\.app|dev\.ash\.(?:mac|server)\b(?!-)|adopted-from-ash|ash-window-chrome|ash(?:-mac)?-build-number|AshSourceCommit|\bAshMac\b/g },
  { id: "github-legacy-repo", why: "GitHub 上改名前的仓库名（release.json 的 legacyReleaseRepo、旧 appcast 的 XML 命名空间）", re: /noroot777\/ash\b(?!-)/g },
  { id: "windows-box-path", why: "Windows 真机上仓库的实际路径（D:\\ai_workspace\\ash），由机器上的目录决定，不归仓库改",
    re: /ai_workspace(?:\\+|\/)ash\b/g },
];

// ── 兼容值：只在某些文件里留下 ─────────────────────────────────────────────────────────────
const FILE_KEEP = [
  // mac 应用和手机 app 独立于服务端发版、会连到还没升级的服务上：发过去的头、cookie、接口路径、
  // 交给服务端的环境变量写旧名，新旧服务端都认（服务端读两代）。
  { id: "client-to-older-server", why: "独立发版的客户端（mac 应用 / 手机 app）发给服务端的旧名：对面可能还是旧版，新版服务端两代都认",
    files: /^(desktop\/|mobile\/|scripts\/macos-client-guard\.mjs$|scripts\/test-macos-(client|update)\.mjs$)/,
    re: /x-ash-[a-z-]+/g },
  { id: "mac-launcher-env", why: "mac 启动器在登录 shell 里用字面量盖掉 rc 文件导出的同名变量；rc 里写的多半是旧名，换成新名会和它同时出现、值不同时服务端拒绝启动（readStorageEnv）",
    files: /^desktop\/macos\/Sources\/ServerLauncher\.swift$/, re: /ASH_(?:DATA_DIR|LOCAL_ONLY|WINDOW_PORT)\b/g },
  // 测试里只有两处是启动器那一侧：假服务读到的（`process.env.ASH_DATA_DIR`）和 rc 文件里导出的；交给 app 本身的配置照换。
  { id: "mac-launcher-env", why: "mac 启动器交给服务端的旧名（假服务读到的、rc 文件里导出的），见 ServerLauncher.swift",
    files: /^scripts\/test-macos-client\.mjs$/, re: /(?<=process\.env\.|export [^\n]*)ASH_(?:DATA_DIR|LOCAL_ONLY|WINDOW_PORT)\b/g },
  { id: "brand-check-message", why: "界面文字残留检查的报错：说的是要找的旧产品名", files: /^scripts\/check-conventions\.mjs$/, re: /(?<=旧产品名 |仍叫 )ash/g },
  // 库文件已经改叫 navi.db（docs/rename-db.md）。旧名只留在讲老安装、讲迁移的地方。
  { id: "db-file", why: "改名之前的库文件名 ash.db（LEGACY_DB_FILE）：讲老安装兼容与库改名的代码注释、文档，以及写着当时事实的历史记录",
    files: /^(\.gitignore|README\.md|docs\/(rename-db|install|relocate-checkout|win-remote|windows-testing)\.md|desktop\/macos\/(README\.md|Sources\/(DataImport|NaviConfig)\.swift)|server\/src\/db\/path\.ts|server\/scripts\/test-db-file\.ts|scripts\/(rename-db|rename-db-core|db-file)\.mjs)$/,
    re: /\bash\\?\.db\b/g },
  // 测试夹具显式指定的临时库（`NAVI_DB=<临时目录>/ash.db` 一类）：名字随便起，跟默认库名、迁移都无关。换它要碰两百多份
  // 测试、和在途分支全冲突，换完行为一点不变，所以不换；新写的夹具照新名写。
  { id: "db-file-fixture", why: "测试夹具里显式指定的临时库文件名：名字随便起的，与默认库名无关（默认库名的回归在 test-db-file.ts）",
    files: /^(server\/scripts\/|web\/scripts\/|scripts\/test-)/, re: /\bash\\?\.db\b/g },
  { id: "drizzle-env", why: "drizzle-kit 的库路径按各代变量名依次认（NAVI_DB → ASH_DB → HARNESS_DB）", files: /^server\/drizzle\.config\.ts$/, re: /\bASH_DB\b/g },
  { id: "mac-legacy-app-prompt", why: "说的是改名前的 Ash.app（没接过它的登录和页面设置时的提示）", files: /^desktop\/macos\/Sources\/AppDelegate\.swift$/, re: /\bAsh\b(?= 的| 里| 那份)/g },
  { id: "qr-test-vector", why: "二维码编码的测试向量：期望的摘要按这段输入算出来的，换了输入摘要就对不上", files: /^web\/scripts\/test-qr\.ts$/, re: /(?<=")ash(?=", 0, 21,)/g },
  { id: "frozen-monitor-kind-dto", why: FROZEN + "（缺 kind 的旧 DTO 归一成 ash 哨兵）", files: /^web\/scripts\/test-monitor-inspector\.tsx$/, re: /ash(?= 哨兵)|(?<=补 ")ash|(?<=归一成 )ash/g },
  { id: "legacy-persisted-text-test", why: "老记录里两代产品名都要认：逐个喂进去", files: /^web\/scripts\/test-conversation-notes\.mjs$/, re: /(?<=")ash(?=", "Navi")/g },
  { id: "legacy-mcp-name-test", why: "专测历史登记名 ash 的用例：两个旧名各关一条、白名单里只有旧名",
    files: /^server\/scripts\/(test-(ash|navi)-mcp-registry|mcp-multi-source-cases)\.ts$/,
    re: /ash(?=: \{ command: "a", disabled: true \}, harness)/g },
  // 用例名写着「只有历史名 ash」的那一行：引号里的 ash 是喂进去的旧登记名。
  { id: "legacy-mcp-name-test", why: "专测历史登记名 ash 的用例（用例名里写着「历史名 ash」）",
    files: /^server\/scripts\//, re: /(?<=历史名 )ash|(?<=历史名 ash[^\n]*["'])ash(?=["'])/g },
  { id: "legacy-log-tag", why: "预览脚本自述那一行故意打旧前缀 [ash]（LEGACY_LOG_TAG：拉起预览的可能还是改名前的服务）",
    files: /^server\/scripts\/test-preview-host-api\.ts$/, re: /(?<=\[)ash(?=\\\\\] preview-api-host)/g },
];

// 上面两条旁证（同行有别的代名、附近有「改名」「旧版」字眼）认错的地方：这里的 ash 说的是这个产品本身
// （或当时的现名），照换。命中即换，压过所有保留规则。
const FORCE_RENAME = [
  { files: /^server\/src\/turn-stall-journal\.ts$/, re: /(?<=只有 |而 )ash(?= 自己在追加| 对同一个库文件)/g },
  { files: /^scripts\/dev\.mjs$/, re: /(?<=宿主 )ash(?= 自己环境)|(?<=由 )ash(?= 在组预览)/g },
  { files: /^server\/src\/claude-monitor-hook\.ts$/, re: /ash(?= 拉起的 claude)/g },
  { files: /^server\/src\/turn-identity\.ts$/, re: /ash(?= 从一个改名之前的任务里起来时)/g },
  { files: /^scripts\/restart\.mjs$/, re: /(?<=另一个 )ash/g },
  { files: /^desktop\/macos\/Sources\/(Ash|Navi)Config\.swift$/, re: /(?<=另一份 )ash(?=（不管新旧）)/g },
  { files: /^server\/scripts\/test-codex-provider\.ts$/, re: /ash(?= 自己那份 MCP)|(?<=test-)ash(?=-mcp-inject)/g },
  { files: /^server\/src\/mcp-registry\/(register|shapes)\.ts$/, re: /(?<=按 |两边都叫 |它才是 )ash(?= 登记| 之后| 会去写)/g },
  { files: /^server\/src\/executors\/(ash|navi)-mcp-confirm\.ts$/, re: /(?<=只认本名 `)ash(?=`)/g },
  { files: /^(docs\/install\.md|scripts\/mcp-hosts\.mjs)$/, re: /(?<=已有 `?)ash(?=`? 或历史名)/g },
  { files: /^server\/src\/handoff-types\.ts$/, re: /(?<=remote)Ash\b/g },
  // 「这是不是任务分支」的判断（点下去要多确认一步）：夹具里的任务分支是现在的前缀，这里跟着换。
  { files: /^web\/scripts\/base-update-recovery-checks\.mjs$/, re: /(?<=\^\()ash(?=\|harness\))|(?<=任务分支（)ash(?=\/ harness\/)/g },
  // 验收打的标签现在叫 navi-accepted/（git-accept.ts），夹具跑的是真服务端，期待跟着换。
  { files: /^web\/scripts\/branch-acceptance-checks\.mjs$/, re: /(?<=tagText\.includes\(")ash(?=-accepted\/)/g },
  { files: /^server\/src\/task-change-scope\.ts$/, re: /(?<=改名成 )ash(?= 之后)|(?<=新任务是 `)ash(?=\/)/g },
  { files: /^server\/scripts\/test-(ash|navi)-mcp-inject\.ts$/, re: /(?<=不说 )ash(?= 的事)/g },
];

// 机械换不出来、要顺手补一句的地方（找不到原文就跳过，所以重跑不会补两遍）。
const PATCHES = [
  // drizzle-kit 读库路径只认旧名：补上新名，旧名留在后面兜底（上面 drizzle-env 认着它）。
  { file: "server/drizzle.config.ts", from: "process.env.ASH_DB ?? process.env.HARNESS_DB", to: "process.env.NAVI_DB ?? process.env.ASH_DB ?? process.env.HARNESS_DB" },
  // 规则文件（见 SKIP 那段）：只换会让说明变错的包名，同一句里顺手省几个字，整份字节不涨。
  { file: "server/CLAUDE.md", from: "要共享运行时函数就照 `@ash/shared/team` 开子路径导出", to: "要共享运行时函数照 `@navi/shared/team` 开子路径导出" },
  { file: "docs/incidents.md", from: "`@ash/shared` 会解析到主仓那份**（本次首跑就是这么撞出来的：", to: "`@navi/shared` 会解析到主仓那份**（本次首跑是这么撞出来的：" },
  { file: "docs/incidents.md", from: "改 shared 时先 `ln -sfn ../../shared node_modules/@ash/shared`", to: "改 shared 时先 `ln -sfn ../../shared node_modules/@navi/shared`" },
  // 喂进去的是改名前落盘的原文，界面归一成现在的文案，断言看的是归一之后（大写的 Navi，机械换只会给小写）。
  { file: "web/scripts/test-conversation-notes-dom.mjs", from: "/ash 已经把这个失效的 id 清掉/", to: "/Navi 已经把这个失效的 id 清掉/" },
  // 断言字节数的夹具：`[ash]` 换成 `[navi]` 多一个字节。
  { file: "server/scripts/test-accept-gate-watch.ts", from: "// 34 字节，命令自己打的", to: "// 35 字节，命令自己打的" },
  { file: "server/scripts/test-accept-gate-watch.ts", from: "命令自己的输出累计 34B。", to: "命令自己的输出累计 35B。" },
];

// 整份讲兼容的文件：字面量、注释里的旧名都是故意的（迁移表、兼容回归的输入与断言）。这里只换代码里
// 声明过的符号（`isAshMcpServerName`）和指向改了名的文件的路径（`@ash/shared/x`、`../src/ash-presence.js`）。
const COMPAT_FILES = new Set([
  "server/scripts/test-rename-compat.ts",
  "web/src/lib/storageRename.ts",
  "web/scripts/test-storage-rename.mjs",
  "web/src/settings/previewAssistTabs.ts",
  "mobile/src/lib/storedKeys.ts",
  "mobile/scripts/test-stored-keys.mjs",
  "desktop/macos/Sources/LegacyIdentity.swift",
  "desktop/macos/Tests/Identity/main.swift",
  "desktop/macos/release.json",
  "desktop/macos/scripts/appcast.mjs",
  "scripts/test-macos-identity.mjs",
  "scripts/test-macos-sparkle-dmg.mjs",
  "scripts/test-macos-release.mjs",
  "server/scripts/test-user-cli-mcp.ts",
  // 界面文字里旧产品名的残留检查（web 构建前置）：它要找的就是 ash。
  "scripts/check-brand-text.mjs",
]);
// 整份讲兼容的文件里也照换的：测试自己读写的环境变量、两边都换了名的交接变量（mac 应用交给 bundle-users.sh 的
// 锁持有者、发版脚本的测试钩子）—— 留旧名就和另一边对不上。
const COMPAT_FORCE = /process\.env\.ASH_\w+|\bASH_LOCK_HOLDER\b|\bASH_MAC_\w+/g;
const COMPAT_WHY = "整份讲改名兼容的文件（迁移表、兼容回归）：字面量和注释里的旧名是故意的";

// 注释和文档里讲旧名的句子：同一行出现这些字眼，行里的 ash 是在说旧名本身，换掉就成了「依次认 NAVI_X、NAVI_X」。
// 只看那一处前后几十个字：长段落里别处的「旧版」不算。代码里声明过的符号照换（注释里提到的是现在的名字）。
const LEGACY_WORDS = /旧名|旧前缀|旧键|旧值|旧版|旧标签|旧路径|旧目录|旧文件|旧登记|旧表头|旧工具名|旧包|旧应用|读旧写新|改名|升级前|升级之前|上几代|各代|两代|三代|几代|新旧|老版本|历史名|legacy|Legacy|LEGACY/;
const PROSE_REACH = 30;
// 这些文件里的 ash 全是当时的现名、旧名只有 harness：同行并列 harness 也照换（下面两条旁证规则不看这几份）。
const CURRENT_NAME_FILES = new Set(["scripts/test-codex-mcp-setup.mjs"]);
const PROSE_WHY = "注释/文档里讲旧名本身的句子（同一行提到改名、旧名、几代）";
const SIBLING_WHY = "同一行同时写着新旧两代（或 harness 那一代）：这一行是在列举/比对各代名字";

// ── 工具 ─────────────────────────────────────────────────────────────────────────────────
const git = (args, opts = {}) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28, ...opts });
// 要过一遍的文件：已跟踪的，加上没加进 git、也没被忽略的（在途分支刚写、还没 add 的新文件）。改名、--check、
// --report 都从这一份出发 —— 只看索引的话，这些文件不改名、核对和清单也都看不见它们，报「没有要改的」。
function repoFiles() {
  const list = (...extra) => git(["ls-files", "-z", ...extra]).split("\0").filter(Boolean);
  const untracked = list("--others", "--exclude-standard");
  return { files: [...list(), ...untracked], untracked: new Set(untracked) };
}
// 正文能不能当文本改：不含 NUL、按 UTF-8 解码再编码回去逐字节一样，才是能放心改的文本（没换的字节原样写回）。
// 两条缺一条都认不准，不改：
//  · 能往返却含 NUL 的，可能是二进制（wasm 这种格式里有长度字段，ash → navi 多一个字节就坏了），也可能是 UTF-16 文本；
//  · 往返不一样的（别的编码、没登记的二进制），解码时坏字节会被换掉，写回去就毁了。
// 认不准的不按「字节里看不看得见 ash」放行：UTF-16 里 ash 是 61 00 73 00 68 00，看不见不等于没有。一律整次拒绝、
// 清单里点名，让人决定：是二进制就把扩展名登记进 BINARY；是文本就转成 UTF-8、把 NUL 写成转义（\u0000）。
// 登记过的二进制不看正文，字节里出现了 ash 的（latin1 一字节一字符看）在清单里点名，不拦。
function decode(path, buf) {
  if (BINARY.test(path)) return { kind: "binary", tokens: HAS_TOKEN.test(buf.toString("latin1")) };
  const text = buf.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buf)) return { kind: "undecodable" };
  return buf.includes(0) ? { kind: "nul" } : { kind: "text", text };
}
// 索引整份读一次、按路径精确认：不带路径参数（git 把路径参数当通配模式，ash[1].txt 会配上 ash1.txt 那一项）。
// -z 时每一项是「mode sha stage<TAB>路径<NUL>」，路径是第一个 TAB 之后的全部（路径里可以有 TAB）；--debug 在后面
// 跟五行固定格式的缓存信息，最后一行是 flags。认不出这个形状就停下，不猜。
function readIndex() {
  const out = git(["ls-files", "-s", "-z", "--debug"]);
  const index = new Map();
  for (let at = 0; at < out.length; ) {
    const end = out.indexOf("\0", at);
    const tab = out.indexOf("\t", at);
    let next = end + 1;
    for (let line = 0; line < 5 && next > 0; line++) next = out.indexOf("\n", next) + 1;
    const [mode, sha, stage] = out.slice(at, tab).split(" ");
    const flags = end > 0 && next > 0 ? /flags: ([0-9a-f]+)\n$/.exec(out.slice(end + 1, next)) : null;
    if (tab < at || tab > end || !sha || !stage || !flags) throw new Error(`认不出 git ls-files --debug 的输出（第 ${index.size + 1} 项附近），停下`);
    const path = out.slice(tab + 1, end);
    index.set(path, [...(index.get(path) ?? []), { mode, sha, stage, flags: Number.parseInt(flags[1], 16) }]);
    at = next;
  }
  return index;
}
// 挪名是自己改名、再把索引项（mode + blob）原样挪到新名上；带下面这几种标志的项挪过去就变了样（intent-to-add
// 会变成暂存了一份空文件，另两种会丢掉），改正文时 assume-unchanged / skip-worktree 还会让 git 看不见这次改动。
const INDEX_FLAGS = [
  [0x8000, "assume-unchanged", "git update-index --no-assume-unchanged"],
  [0x40000000, "skip-worktree", "git update-index --no-skip-worktree"],
  [0x20000000, "intent-to-add", "git add"],
];
/** 脚本要挪、要改的已跟踪文件，索引里必须恰好是一份普通的 stage 0 项；不是的说清为什么。 */
function indexProblem(entries) {
  if (!entries?.length) return "索引里找不到它";
  if (entries.length > 1 || entries[0].stage !== "0") return "有没解决的冲突，先解决再跑";
  const marked = INDEX_FLAGS.filter(([bit]) => entries[0].flags & bit);
  if (!marked.length) return null;
  return `索引里标着 ${marked.map(([, name]) => name).join("、")}，挪名带不走、改了 git 可能看不见；先 ${marked.map(([, , fix]) => fix).join("、")} 再跑`;
}
// 给人照抄的命令里的路径：单引号括起来，里面的单引号断开转义（路径里的空格、通配符、$ 都不会被 shell 解释）。
const shellQuote = (path) => `'${path.replaceAll("'", "'\\''")}'`;

/** 一行里哪些区间是注释（或整份是文档）。粗认：行首注释记号，或不在引号里的 ` //`。 */
function commentRanges(path, line) {
  if (/\.md$/.test(path)) return [[0, line.length]];
  const lead = /^\s*(\/\/|\/\*|\*|#(?!!)|<!--|--)/.exec(line);
  if (lead && !/\.(json)$/.test(path)) return [[0, line.length]];
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && line[i + 1] === "/" && (i === 0 || /\s/.test(line[i - 1]))) return [[i, line.length]];
  }
  return [];
}

/** 这一列是不是在引号里（粗认：从行首数没配对的引号）。 */
function inString(line, col) {
  let quote = null;
  for (let i = 0; i < col; i++) {
    const c = line[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; }
    else if (c === '"' || c === "'" || c === "`") quote = c;
  }
  return quote !== null;
}

/** 这一列是不是在正则字面量里（粗认：跟在运算符/括号/逗号后面的 `/…/`）。 */
const REGEX_LITERAL = /(?<=(?:^|[=(,:!&|?{};\[]|\breturn)\s*)\/(?![\/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\/\\\n\[])+\/[a-z]*/g;
const inRegex = (line, col) => [...line.matchAll(REGEX_LITERAL)].some((m) => m.index < col && col < m.index + m[0].length);

/** 词元所在的「宽复合词」：标识符字符加上 `-./:@`（`x-ash-turn-token`、`ash/Ab3d`、`@ash/shared`）。 */
function compoundAt(text, start, end, chars) {
  let a = start, b = end;
  while (a > 0 && chars.test(text[a - 1])) a--;
  while (b < text.length && chars.test(text[b])) b++;
  return [a, b];
}
const NARROW = /[A-Za-z0-9_$]/;
const WIDE = /[A-Za-z0-9_$.\-\/:@]/;
const trimPunct = (s) => s.replace(/^[.\-\/:]+|[.\-\/:]+$/g, "");

/** 同一行里有没有这一个复合词的另一代（新名，或 harness 那一代）。 */
function hasSibling(line, compound, offset) {
  const tokenAt = (re) => new RegExp(`(?<![A-Za-z0-9_$])${re.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$])`).test(line);
  const word = compound.slice(offset, offset + 3);
  for (const other of [CASES[word], { ash: "harness", Ash: "Harness", ASH: "HARNESS" }[word]]) {
    const sibling = compound.slice(0, offset) + other + compound.slice(offset + 3);
    if (tokenAt(sibling)) return true;
  }
  return false;
}

// ── 每个文件：哪些 ash 留、为什么 ──────────────────────────────────────────────────────────
function keepSpans(path, text) {
  const spans = [];
  for (const rule of [...GLOBAL_KEEP, ...FILE_KEEP]) {
    if (rule.files && !rule.files.test(path)) continue;
    if (rule.except && rule.except.test(path)) continue;
    for (const m of text.matchAll(rule.re)) spans.push({ from: m.index, to: m.index + m[0].length, rule });
  }
  return spans;
}

/** 整份讲兼容的文件里，这一处要不要照换：代码里声明过的符号、指向改了名的文件的路径。 */
function compatRenames(text, index, ctx) {
  const [a, b] = compoundAt(text, index, index + 3, NARROW);
  const narrow = text.slice(a, b);
  if (narrow !== text.slice(index, index + 3) && ctx.symbols.has(narrow)) return true;
  if (text.slice(index - 1, index) === "@" && text[index + 3] === "/") return true; // @ash/ 包作用域
  const [c, d] = compoundAt(text, index, index + 3, /[A-Za-z0-9_\-]/);
  return ctx.renamedStems.has(text.slice(c, d));
}

/**
 * 算出一个文件的新内容，以及每一处 ash 的去留。`decisions` 里的每一项：{ index, line, kept, why }。
 */
export function rewrite(path, text, ctx) {
  const spans = keepSpans(path, text);
  const compat = COMPAT_FILES.has(path);
  const forcedRename = FORCE_RENAME.filter((r) => r.files.test(path)).flatMap((r) => [...text.matchAll(r.re)].map((m) => ({ from: m.index, to: m.index + m[0].length })));
  const forced = compat ? [...text.matchAll(COMPAT_FORCE)].map((m) => ({ from: m.index, to: m.index + m[0].length })) : [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (index) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= index) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const decisions = [];
  let out = "";
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const index = m.index;
    const lineNo = lineOf(index);
    const lineStart = lineStarts[lineNo];
    const lineEnd = lineNo + 1 < lineStarts.length ? lineStarts[lineNo + 1] - 1 : text.length;
    const line = text.slice(lineStart, lineEnd);
    const col = index - lineStart;
    let why = null;
    const span = spans.find((s) => s.from <= index && index + 3 <= s.to);
    if (forcedRename.some((f) => f.from <= index && index + 3 <= f.to)) why = null;
    else if (span) why = span.rule.id;
    else if (compat && !compatRenames(text, index, ctx) && !forced.some((f) => f.from <= index && index + 3 <= f.to)) why = "compat-file";
    else if (!CURRENT_NAME_FILES.has(path)) {
      const [a, b] = compoundAt(line, col, col + 3, WIDE);
      const raw = line.slice(a, b);
      const lead = raw.length - raw.replace(/^[.\-\/:]+/, "").length;
      const wide = trimPunct(raw);
      const wideOffset = col - a - lead;
      const [na, nb] = compoundAt(line, col, col + 3, NARROW);
      const inComment = commentRanges(path, line).some(([s, e]) => s <= col && col < e);
      // 代码里的标识符（`process.env.HARNESS_DB = process.env.ASH_DB`）不算列举：只看字面量和注释。
      if ((inComment || inString(line, col) || inRegex(line, col)) && (hasSibling(line, line.slice(na, nb), col - na)
        || (wideOffset >= 0 && wideOffset + 3 <= wide.length && hasSibling(line, wide, wideOffset)))) why = "sibling";
      else if (inComment && !ctx.symbols.has(line.slice(na, nb))
        && LEGACY_WORDS.test(line.slice(Math.max(0, col - PROSE_REACH), col + 3 + PROSE_REACH))) why = "prose";
    }
    decisions.push({ line: lineNo + 1, text: line, kept: why !== null, why });
    if (why === null) { out += text.slice(last, index) + CASES[m[0]]; last = index + 3; }
  }
  out += text.slice(last);
  // 英文冠词跟着读音走：an ash → a navi。
  return { text: out.replace(/\b([Aa])n (?=navi\b)/g, "$1 "), decisions };
}

// ── 上下文：声明过的符号、改了名的文件 ─────────────────────────────────────────────────────
const DECL = /\b(?:export\s+)?(?:const|let|var|function\*?|class|interface|type|enum|struct|protocol|func|typealias|static\s+(?:let|var|func))\s+([A-Za-z_$][\w$]*)/g;
function buildContext(files, readText) {
  const symbols = new Set();
  const renamedStems = new Set();
  for (const path of files) {
    const stem = basename(path, extname(path));
    if (HAS_TOKEN.test(stem)) renamedStems.add(stem);
    if (!/\.(ts|tsx|mjs|js|cjs|swift)$/.test(path)) continue;
    const text = readText(path);
    if (text === null) continue;
    for (const m of text.matchAll(DECL)) {
      const name = m[1];
      if (!/^(ash|Ash|ASH)$/.test(name) && HAS_TOKEN.test(name)) symbols.add(name);
    }
  }
  return { symbols, renamedStems };
}

const renamePath = (path) => path.split("/").map(renameText).join("/");

// ── 包清单与锁文件：包名换了，npm 按键名排的顺序也跟着变（不排的话下一次 npm install 会把锁文件重排一遍）──
const byName = (a, b) => a.localeCompare(b, "en");
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
function sortDeps(entry) {
  for (const field of DEP_FIELDS) {
    if (entry?.[field] && typeof entry[field] === "object") {
      entry[field] = Object.fromEntries(Object.entries(entry[field]).sort(([a], [b]) => byName(a, b)));
    }
  }
}
function normalizeManifest(text, isLock) {
  const doc = JSON.parse(text);
  if (isLock && doc.packages) {
    const keys = Object.keys(doc.packages);
    const sorted = {};
    for (const k of [...keys.filter((k) => k === ""), ...keys.filter((k) => k !== "").sort(byName)]) {
      sortDeps(doc.packages[k]);
      sorted[k] = doc.packages[k];
    }
    doc.packages = sorted;
  } else if (!isLock) sortDeps(doc);
  return JSON.stringify(doc, null, 2) + "\n";
}

// ── 主流程 ───────────────────────────────────────────────────────────────────────────────
function plan() {
  const { files, untracked } = repoFiles();
  const cache = new Map();
  // 读不到（权限、IO……）跟「是二进制、不用看」是两回事：前者记下来，最后整体拒绝，别当成没东西要换。
  const unreadable = [];
  // 符号链接、还没提交的删除碰上要挪名、要修的：做不完整，动手之前整次拒绝（别等挪到一半才发现源文件不在）。
  const blocked = [];
  const kinds = new Map();
  const outside = new Map();
  // 规划时每个普通文件是哪一份（设备 + inode）：动手时按它复核，规划之后被换掉的不拿规划的结论去挪、去盖。
  const ids = new Map();
  const kindOf = (path) => {
    if (!kinds.has(path)) {
      let value;
      try {
        const why = ancestorProblem(path);
        if (why) outside.set(path, why);
        value = why ? "outside" : diskKind(path);
        if (value === "file") ids.set(path, identity(path));
      } catch (error) {
        value = "unreadable";
        unreadable.push(`${path}：${error?.code ?? error}`);
      }
      if (value === "other") unreadable.push(`${path}：不是普通文件`);
      kinds.set(path, value);
    }
    return kinds.get(path);
  };
  // 正文没按文本读的（见 decode）：认不准的整次拒绝，都在清单里说清。
  const opaque = new Map();
  const readText = (path) => {
    if (cache.has(path)) return cache.get(path);
    let value = null;
    if (kindOf(path) === "file") {
      try {
        const buf = readFileSync(join(REPO, path));
        const content = decode(path, buf);
        if (content.kind === "text") value = content.text;
        else opaque.set(path, content);
      } catch (error) {
        unreadable.push(`${path}：${error?.code ?? error}`);
      }
    }
    cache.set(path, value);
    return value;
  };
  const ctx = buildContext(files, readText);
  const moves = [];
  const edits = [];
  const kept = [];
  const ruleFiles = [];
  const fixProblems = [];
  // 整份新加的文件（content）：落点按磁盘上的实况认，不按 git 清单 —— 没加进 git 的同名文件也是别人的东西。
  // 没有就建；已经有、带着记号就是它（加没加进 git 都一样），不动；有但不是它，整次拒绝。
  for (const fix of FIXES) {
    if (files.some((path) => renamePath(path) === fix.file)) continue;
    if (fix.content === undefined) fixProblems.push(`${fix.file}：文件不见了`);
    else if (kindOf(fix.file) === "outside") blocked.push(`${fix.file}：要新建的文件${outside.get(fix.file)}，不透过它建`);
    else if (kindOf(fix.file) === "link") blocked.push(`${fix.file}：要新建的文件那里是一个符号链接，不透过它写`);
    else if (kindOf(fix.file) === "missing") edits.push({ path: fix.file, target: fix.file, text: fix.content, create: true });
    else if (!(readText(fix.file) ?? "").includes(fix.marker)) fixProblems.push(`${fix.file}：要新建的文件那里已经有一份别的内容（没加进 git 也算），不覆盖`);
  }
  for (const path of files) {
    const kind = kindOf(path);
    if (kind === "outside") {
      blocked.push(`${path}：${outside.get(path)}，不透过它读写`);
      continue;
    }
    if (kind === "link" || kind === "missing") {
      // 不读、不写它的正文；要它挪名、要给它套修复，就是做不完的活。
      const target = renamePath(path);
      const fixed = FIXES.some((fix) => fix.file === path || fix.file === target);
      const what = kind === "link" ? `符号链接（指向 ${readlinkSync(join(REPO, path))}）` : "在工作区里删掉了、删除还没提交";
      if (kind === "link" && HAS_TOKEN.test(readlinkSync(join(REPO, path)))) blocked.push(`${path}：${what}，链接里写着旧名，手工改`);
      else if (target !== path || fixed) blocked.push(`${path}：${what}，${target !== path ? `要挪成 ${target}` : "要套手写修复"}`);
      continue;
    }
    if (SKIP_FILES.has(path)) {
      // 不改名，但手写修复照样套（旧名登记处添一项新的旧名，就是这种）。
      const text = readText(path);
      let next = text;
      for (const fix of FIXES) if (fix.file === path && next !== null) next = applyFix(fix, next, fixProblems);
      if (next !== text) edits.push({ path, target: path, text: next });
      continue;
    }
    let text = readText(path);
    const target = renamePath(path);
    const unsure = OPAQUE_WHY[opaque.get(path)?.kind];
    if (unsure) blocked.push(`${path}：${unsure}`);
    for (const patch of PATCHES) if (patch.file === path && text?.includes(patch.from) && !text.includes(patch.to)) text = text.replace(patch.from, patch.to);
    if (target !== path) moves.push([path, target]);
    if (text === null) continue;
    if (isRuleFile(path)) {
      if (text !== readText(path)) edits.push({ path, target, text });
      text.split("\n").forEach((line, i) => { if (HAS_TOKEN.test(line)) ruleFiles.push({ path, line: i + 1, text: line }); });
      continue;
    }
    const result = rewrite(path, text, ctx);
    for (const d of result.decisions) if (d.kept) kept.push({ path: target, ...d });
    let next = result.text;
    if (/(^|\/)package(-lock)?\.json$/.test(path) && next !== text) next = normalizeManifest(next, path.endsWith("-lock.json"));
    for (const fix of FIXES) if (fix.file === target) next = applyFix(fix, next, fixProblems);
    if (next !== readText(path)) edits.push({ path, target, text: next });
  }
  // 要挪、要改的已跟踪文件，索引项在规划时就认准（按路径精确认，见 readIndex）：有冲突、带标志的整次拒绝，
  // 动手时直接用这里认下的 mode + blob，不再起 git 查。
  const index = readIndex();
  const touched = new Set([...moves.map(([from]) => from), ...edits.filter((edit) => !edit.create).map((edit) => edit.path)]);
  for (const path of touched) {
    const why = untracked.has(path) ? null : indexProblem(index.get(path));
    if (why) blocked.push(`${path}：${why}`);
  }
  // 挪名的落点同样逐级认：源在仓库里、落点的上级是链接（比如 ash-dir 改名后的 navi-dir 已经是一个链接）也不行。
  for (const [from, to] of moves) {
    try {
      const why = ancestorProblem(to);
      if (why) blocked.push(`${from} → ${to}：落点${why}，不透过它挪`);
    } catch (error) {
      unreadable.push(`${to}：${error?.code ?? error}`);
    }
  }
  // 改正文时拿什么复核：规划时读到的原文和那一份的身份（动手前内容或身份变了就停下）。
  for (const edit of edits) if (!edit.create) Object.assign(edit, { original: readText(edit.path), id: ids.get(edit.path) });
  return { moves, edits, kept, ruleFiles, unreadable, blocked, fixProblems, files, untracked, ids, index, readText, opaque };
}

/** 手写修复：文件里已经有它的记号就算修过了（之后再怎么改都不碰）；没有就逐段按原文替换，哪段对不上都整份不动、记下来。 */
function applyFix(fix, text, problems) {
  if (text.includes(fix.marker)) return text;
  if (fix.content !== undefined) {
    problems.push(`${fix.file}：要新建的文件已经有一份别的内容（没有记号 ${JSON.stringify(fix.marker)}），不覆盖`);
    return text;
  }
  let next = text;
  for (const [i, { from, to }] of fix.hunks.entries()) {
    const at = next.indexOf(from);
    if (at < 0 || next.indexOf(from, at + 1) >= 0) {
      problems.push(`${fix.file}：第 ${i + 1} 段${at < 0 ? "找不到原文" : "原文出现了不止一处"}（${fix.why}）`);
      return text;
    }
    next = next.slice(0, at) + to + next.slice(at + from.length);
  }
  if (!next.includes(fix.marker)) problems.push(`${fix.file}：补完之后仍然没有记号 ${JSON.stringify(fix.marker)}`);
  return next;
}

const WHY = Object.fromEntries([...GLOBAL_KEEP, ...FILE_KEEP].map((r) => [r.id, r.why]));
Object.assign(WHY, { "compat-file": COMPAT_WHY, prose: PROSE_WHY, sibling: SIBLING_WHY, "legacy-registry": "旧名登记处：兼容要认的旧名只在这两份里登记（各自的文件头写着），整份不进改名" });

/** 动手之前先把挪名的落点全查一遍：有一个已经被占（在途分支自己建过同名新文件）就一个都不动。 */
function moveConflicts(moves) {
  const sources = new Set(moves.map(([from]) => from));
  const seen = new Map();
  const conflicts = [];
  for (const [from, to] of moves) {
    if (seen.has(to)) conflicts.push(`${from} 和 ${seen.get(to)} 都要挪到 ${to}`);
    seen.set(to, from);
    // 按 lstat 认：落点是一个断了的符号链接也算被占（existsSync 会顺着链接看，说它不在）。
    if (!sources.has(to) && diskKind(to) !== "missing") conflicts.push(`${from} → ${to}：落点已经有文件了`);
  }
  return conflicts;
}

function apply({ moves, edits, untracked, ids, index }) {
  const done = [];
  try {
    // 先建新文件：核对之后、写之前有人建了同名文件，wx 让这一步失败，而且失败时别的都还没动。
    for (const { target, text } of edits.filter((edit) => edit.create)) {
      writeInRepo(target, text, true, done);
    }
    for (const [from, to] of moves) {
      // 没加进 git 的只改名。已跟踪的：改名之后把规划时认下的索引项（mode + blob）原样挪到新名上 —— 暂存的内容
      // 不变。核对和 rename 紧挨着，在 moveInRepo 里。
      if (untracked.has(from)) {
        moveInRepo(from, to, ids.get(from), done, "（没加进 git）");
        continue;
      }
      const [{ mode, sha }] = index.get(from);
      moveInRepo(from, to, ids.get(from), done);
      try {
        git(["update-index", "-z", "--index-info"], { input: `0 ${"0".repeat(sha.length)}\t${from}\0${mode} ${sha} 0\t${to}\0` });
      } catch (error) {
        // update-index 失败时 git 不换上新索引：索引里仍是旧名那一项，只有工作区里挪了。
        done.push(`  ↳ 索引没更新（里面仍是旧名那一项），工作区里已经挪了：先解决失败的原因，再挪回去 mv -- ${shellQuote(to)} ${shellQuote(from)}`);
        throw error;
      }
    }
    for (const { target, text, original, id } of edits.filter((edit) => !edit.create)) {
      writeInRepo(target, text, false, done, { original, id });
    }
  } catch (error) {
    console.error(`改到一半失败：${error?.message ?? error}`);
    console.error(`已经做完的 ${done.length} 步（其余没动）：\n${done.map((step) => `  ${step}`).join("\n")}`);
    console.error("在干净检出上跑的：git reset --hard HEAD 回到跑之前，修好原因再跑。加了 --dirty 跑的：别整仓重置（会连你没提交的改动一起丢），按上面的清单逐个挪回去（标着「没加进 git」的用 mv，其余 git mv）、对改过的文件逐个处理，「建了目录」的删掉。");
    process.exit(3);
  }
}

const args = new Set(process.argv.slice(2));
const result = plan();
if (result.unreadable.length) {
  console.error(`有 ${result.unreadable.length} 个文件读不到，没法判断要不要换（${args.has("--check") || args.has("--report") ? "核对" : "改名"}不算数）：\n${result.unreadable.map((line) => `  ${line}`).join("\n")}`);
  process.exit(4);
}
if (result.fixProblems.length) {
  console.error(`手写修复（scripts/rename-navi-fixes.mjs）对不上，一个文件都没动：\n${result.fixProblems.map((line) => `  ${line}`).join("\n")}\n多半是这几个文件在别处改过：手工把对应的修复补上（补完文件里就有记号了），再跑。`);
  process.exit(5);
}
if (result.blocked.length && !args.has("--report")) {
  console.error(`有 ${result.blocked.length} 处改名做不完整，一个文件都没动${args.has("--check") ? "（核对不算通过）" : ""}：\n${result.blocked.map((line) => `  ${line}`).join("\n")}\n还没提交的删除：先 git rm 把删除提交（或恢复那个文件）；符号链接：脚本不透过它改文件，也不替你挪它，手工处理之后再跑。`);
  process.exit(2);
}
if (args.has("--report")) {
  process.stdout.write(renderReport(result, { registryFiles: REGISTRY_FILES, toolingFiles: TOOLING_FILES, remaining: REMAINING, why: WHY, token: HAS_TOKEN }));
} else if (args.has("--check")) {
  for (const [from, to] of result.moves) console.log(`move ${from} → ${to}`);
  for (const { path } of result.edits) console.log(`edit ${path}`);
  process.exit(result.moves.length || result.edits.length ? 1 : 0);
} else {
  // 没加进 git 的文件也算不干净：它们同样会被改名，改坏了 git reset --hard 退不回来。
  if (git(["status", "--porcelain"]).trim() && !args.has("--dirty")) {
    console.error("工作区不干净（有未提交的改动或没加进 git 的文件）：先提交（新文件先 git add）或挪开，改名要在干净的检出上跑（或者加 --dirty 硬跑）");
    process.exit(2);
  }
  const conflicts = moveConflicts(result.moves);
  if (conflicts.length) {
    console.error(`挪名的落点有冲突，一个文件都没动：\n${conflicts.map((line) => `  ${line}`).join("\n")}\n先把同名的新文件和旧文件合成一份（保留新名那份），再跑。`);
    process.exit(2);
  }
  apply(result);
  console.log(`改名：挪了 ${result.moves.length} 个文件，改了 ${result.edits.length} 个文件；留下 ${result.kept.length} 处兼容值（--report 看清单）`);
  console.log("接着：npm install（工作区包换了作用域），再按 scripts/rename-navi.mjs 的报告核对。");
}
