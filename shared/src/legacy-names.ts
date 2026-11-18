// 改名兼容：上几代产品名（ash ← harness）在**跨进程、落盘、落库、用户配置**里留下的字样。
//
// 这些字样只在这一份文件里出现，并且一律以 `LEGACY_` 起名 —— 别处要认旧名就从这里取，不要
// 在别处再写一遍字面量。原因有二：
//  · 批量机械改名（把仓库里剩下的 ash 换成 navi）要能整份跳过这个文件，旧名才不会被一起换掉；
//  · 拆兼容层的时候删这一份、跟着编译错误走，就知道还有谁在认旧名。
// 同样的几项在 `scripts/legacy-names.mjs` 有一份镜像（那边要在 Node 22.16 上裸跑、导不了 .ts），
// `server/scripts/test-rename-compat.ts` 钉住两份一致。
//
// 每一项后面写明「什么时候可以拆」。没写「冻结」的，都是读旧写新：新版只写当前名，旧名只在读的
// 一侧认。写「冻结」的不是名字而是**协议版本号或哈希盐**：换了它，存量数据（库里的签名/摘要）和
// 还没升级的对端一起失配，所以当前版本照旧写它，等协议本身升版时一并换。

/** 环境变量的旧前缀，新的在前（`NAVI_X` 读不到时依次认 `ASH_X`、`HARNESS_X`）。拆：用户启动命令、
 *  launchd/systemd 配置、mac 版启动器都换成 `NAVI_` 之后。 */
export const LEGACY_ENV_PREFIXES = ["ASH_", "HARNESS_"] as const;

/** MCP 服务的旧登记名（工具名 `mcp__ash__…`、codex `[mcp_servers.ash]`）。拆：用户各家 CLI 配置里的
 *  登记都由 setup / 注册执行器改写成新名、且升级前起的会话都已结束之后。 */
export const LEGACY_MCP_SERVER_NAMES = ["ash", "harness"] as const;

/** 任务分支的旧前缀（`ash/<id8>`）。拆：升级前建的任务都已验收或清理、仓库里不再有这种分支之后。 */
export const LEGACY_TASK_BRANCH_PREFIXES = ["ash/", "harness/"] as const;

/** 「只打标签不合并」验收的旧标签前缀。拆：同上，且没人再按旧标签找东西。 */
export const LEGACY_ACCEPT_TAG_PREFIX = "ash-accepted/";

/**
 * 默认库文件的旧名（数据目录下）。老安装继续用它，直到本地目录迁移脚本把它改名；**新安装暂时也建
 * 它**（mac 应用只认这个名字，见 `server/src/db/path.ts`）。拆：mac 应用认得 `navi.db`、迁移脚本交付之后。
 */
export const LEGACY_DB_FILE = "ash.db";
/** 再上一代的库文件名：启动时就地改名成 `LEGACY_DB_FILE`（老逻辑，保留）。 */
export const LEGACY_HARNESS_DB_FILE = "harness.db";

/**
 * 单例锁、资源占用锁、在线登记的旧文件名。**互斥要横跨新旧两版**：旧版只认这几个名字，所以新版
 * 在持有新名的同时也持有一份旧名，旧版起在同一份数据上时照样被挡下。拆：确认不会再有旧版服务、
 * 旧版离线维护脚本跑在这份数据上之后（本地目录迁移完成即可）。
 */
export const LEGACY_SINGLETON_LOCK_SUFFIX = ".ash.lock";
export const LEGACY_RESOURCE_CLAIM_SUFFIX = ".ash-claim.lock";
export const LEGACY_PRESENCE_PREFIX = ".ash-online.";

/** 预览依赖目录「装好了」的旧标记文件。拆：旧标记全部被新标记替换之后（重装一次依赖即可）。 */
export const LEGACY_PREVIEW_DEPS_READY_MARK = ".ash-deps-ready";


/** 我方 HTTP 头的旧前缀（`x-ash-turn-token` 等）。升级前起的 MCP 子进程、钩子、旧版对端还在发。拆：同上 + 局域网对端都升级之后。 */
export const LEGACY_HTTP_HEADER_PREFIX = "x-ash-";

/**
 * 用户 key（`ash_…`）与远程设备令牌（`ashd_…`）的旧前缀。存的是哈希，用户手里拿着的是明文，
 * 升级前发出去的照样要认。拆：旧 key 都重置过、旧设备都重新配对过之后。
 */
export const LEGACY_USER_KEY_PREFIX = "ash_";
export const LEGACY_DEVICE_TOKEN_PREFIX = "ashd_";

/** 会话 cookie 的旧名。拆：旧 cookie 全部过期之后（登录态有效期）。 */
export const LEGACY_SESSION_COOKIE = "ash_session";
export const LEGACY_INSTANCE_COOKIE = "ash_instance";

/**
 * 接力握手里的服务标识（ping 应答的 `service`，以及错误应答上的 `ash: true` 可信标记）。
 * 旧版对端只认这个值，所以本版照旧写它、同时认新值；新标记 `navi: true` 一并写上。
 * 拆：局域网里的对端都升级到认新值的版本之后，改成只写新值。
 */
export const LEGACY_HANDOFF_SERVICE = "ash";


/** 预览批注 postMessage 协议名。升级前打开的预览页里注入的还是旧脚本。拆：那些页面都刷新过之后。 */
export const LEGACY_PREVIEW_ANNOTATION_PROTOCOL = "ash-preview-annotation-v1";

/** git 公共目录下的旧子目录（工作台操作日志、工作区备份）。拆：旧目录里的东西都迁走或过期之后。 */
export const LEGACY_GIT_WORKBENCH_DIR = "ash-workbench";
export const LEGACY_GIT_WORKTREE_BACKUPS_DIR = "ash-worktree-backups";

/**
 * 日志行的旧前缀。有两句日志是**给别的进程读的信号**：预览后端自报 `/api` 打回哪个端口
 * （`scripts/dev.mjs` 打、`server/src/preview-log.ts` 读），以及「真调度器起来了」（`schedules.ts`
 * 打、`preview-start.ts` 读，读到就回收那个预览）。被预览的分支可能是改名之前的代码，打的是旧前缀。
 * 拆：没有改名之前的分支还会被拿来预览之后。
 */
export const LEGACY_LOG_TAG = "[ash]";

/** 回合进展证明文件的旧版本行。只影响升级那一刻正在跑的回合。拆：升级后跑完一轮即可。 */
export const LEGACY_TURN_PROGRESS_WATCH_HEAD = "ash-turn-progress-watch/v2";

/**
 * 合并预览档测试快照的封存标记（快照自己 `.git/config` 里的一个键）。快照活得过服务重启：升级前封的
 * 那一份，收尾核验时照样要认出来。拆：升级前开跑的验收门禁都收完尾之后。
 */
export const LEGACY_SEALED_SNAPSHOT_MARK = "ash.sealedsnapshot";

/**
 * claude 运行时设置文件（系统临时目录下 `<前缀><pid>-<uuid>.json`，带中转密钥）的旧前缀。启动时按前缀
 * 清扫死进程留下的，接回升级前起的智能体时从它的命令行里认出这份文件、跟着它收尾。拆：升级前起的
 * 智能体都结束、旧文件被清扫过一轮之后。
 */
export const LEGACY_CLAUDE_RUNTIME_SETTINGS_PREFIX = "ash-claude-settings-";

/** 逃逸追踪文件（系统临时目录下）的旧前缀。启动时按前缀清扫没人握着的。拆：清扫过一轮之后。 */
export const LEGACY_TRACK_FILE_PREFIX = "ash-track-";

/**
 * 「替本机 CLI 接好 MCP」接口的旧路径。mac 应用（`desktop/macos/Sources/HostMcpSetup.swift`）打的是它，
 * 新旧两条都接。拆：mac 应用改打新路径、旧版应用不再连这台服务之后。
 */
export const LEGACY_HOST_MCP_SETUP_PATH = "/ash-mcp/host-setup";

/** 注入给 claude 的 MCP 配置文件所在子目录（runs/<任务>/ 与数据目录下）的旧名。写新回合时顺手删旧目录里的。拆：升级前的任务目录都被回收之后。 */
export const LEGACY_INJECTED_MCP_DIR = "ash-mcp";

/**
 * claude `/goal` 的目标上下文文件（系统临时目录下 `<前缀><pid>-<uuid>.md`）与命令行里指着它的那段记号
 * （`<记号:"路径">`）。记号随命令行落库，服务重启后收尾时按它找回文件删掉。拆：升级前起的 `/goal` 回合
 * 都收完尾之后。
 */
export const LEGACY_CLAUDE_GOAL_FILE_PREFIX = "ash-claude-goal-";
export const LEGACY_CLAUDE_GOAL_CONTEXT_TAG = "ash-goal-context";

/**
 * Windows 上验收门禁 Job 对象的名字前缀。整串名字记在门禁的启动记录里，接回时按前缀认出它是 Job
 * 而不是 cgroup。拆：升级前开跑的门禁都收完尾之后。
 */
export const LEGACY_WINDOWS_GATE_JOB_PREFIX = "Local\\ash-accept-gate-";

/**
 * Git 工作台贮藏标题里的所有权标记 `[<标签>:<用户摘要>]`。它写进**用户仓库**的贮藏里，工作台按它判断
 * 「这是谁存的」（只有本人能 pop/drop），界面显示时把它剥掉。升级前存的贮藏带旧标签，照样认是本人的。
 * 拆：不再有升级前存下、还没弹出或丢弃的贮藏之后。
 */
export const LEGACY_STASH_OWNER_TAG = "ash";

/**
 * 给 claude 发打断用的 `control_request` 请求号前缀（`<前缀><序号>`）。请求号连同序号记进打断记录
 * （`<输出>.steer.json`），服务重启后接管还在跑的智能体时读回来：按整串请求号对上回执，按序号接着往下编。
 * 拆：升级前起、插过话的智能体都结束之后。
 */
export const LEGACY_CLAUDE_INTERRUPT_ID_PREFIX = "ash_int_";

/**
 * 飞书绑定码的旧前缀（`ASH-XXXX-XXXX`）。用户从网页抄下来发给机器人，机器人从消息里认出它；升级前
 * 生成、还没发出去的那一张照样要认。拆：升级后过了绑定码的有效期（10 分钟）即可。
 */
export const LEGACY_IM_BIND_CODE_PREFIX = "ASH";

// ── 冻结：协议版本号与哈希盐，当前版本照旧写 ────────────────────────────────────────────

/** 接力签名/加密的域标签。换了它，旧版对端验不了签、解不了封，库里已存的签名也作废。拆：接力协议升 v2 时。 */
export const FROZEN_HANDOFF_SIGNATURE_DOMAIN = "ash-handoff-v1";
export const FROZEN_HANDOFF_ENCRYPTION_DOMAIN = "ash-handoff-enc-v1";
export const FROZEN_HANDOFF_ENCRYPTION_MAGIC = "ash-enc1";

/** IM 绑定码摘要的盐。库里存的是加了它的摘要，换了它已绑定的会话全部失效。拆：绑定表重做时。 */
export const FROZEN_IM_BIND_SALT = "ash-im-bind:";

/**
 * 用户仓库里的隐藏 ref 命名空间：任务开工点 / 验收头 / 基线更新备份（`refs/ash/…`）、Git 工作台的
 * 操作备份（`refs/ash-backup/…`）。它们落在**用户的每一个仓库里**，读写点很多而且多是比较交换
 * （`update-ref <ref> <new> <old>`），改名要么双读双写每一处、要么挨个仓库搬 ref，换来的只是一段
 * 用户平常看不见的路径。所以冻结：当前版本照旧读写它。拆：哪天要动，先写一个逐仓库搬 ref 的离线迁移。
 */
export const FROZEN_GIT_REF_NAMESPACE = "refs/ash/";
export const FROZEN_GIT_BACKUP_REF_NAMESPACE = "refs/ash-backup/";

/**
 * 人工授权申请里的用途串（服务端签发、离机签名脚本 `scripts/human-approval.mjs` 严格比对）。签名脚本
 * 跑在**离机设备**上，那份拷贝多半是改名之前的版本，换了它，管理员手里的脚本就拒签。拆：签名协议升版时。
 */
export const FROZEN_HUMAN_APPROVAL_PURPOSE = "ash-human-approval-v1";

/**
 * 智能体运行在操作系统里留下的对象名：进程单元记号的前缀（落库在 `sessions.agent_unit_token`）、
 * Linux cgroup 目录名与 Windows Job Object 名的前缀、守圈就绪文件所在的临时目录、Windows 上包装脚本的
 * 后缀（`scripts/platform.mjs` 重启时靠它认出智能体进程、不误杀）。智能体**活得过服务重启和升级**，
 * 重启后接回、清扫残留都按这些名字去找；换了名字，升级那一刻正在跑的智能体就认不回来（Windows 上
 * 还会在重启时被当成陌生进程）。用户看不见它们，所以冻结。拆：不拆。
 */
export const FROZEN_AGENT_UNIT_PREFIX = "ash-agent-";
export const FROZEN_CONFINE_TMP_DIR = "ash-confine";
export const FROZEN_WINDOWS_AGENT_WRAP_SUFFIX = ".ash-agent-wrap.cjs";
/**
 * Windows 上智能体包装壳守着的输入管道（`\\.\pipe\<前缀><id>`）。管道名由同一份运行目录算出来，
 * 服务重启后接回那个智能体、给它送输入时按名字去连 —— 升级那一刻正在跑的智能体，它的包装壳守着的
 * 是旧名，所以跟上面几项一起冻结。拆：不拆。
 */
export const FROZEN_WINDOWS_STDIN_PIPE_PREFIX = "ash-stdin-";

/**
 * 哨兵的出身（`monitors.kind`、接口里的 `kind`）里「Navi 自己起的那种」的值。它落在每一行哨兵记录上，
 * 停止、接回、交接、完成闸的查询都按它筛；装在手机上的 app、没刷新的页面、局域网里的旧版对端读到
 * 别的值，会把这条哨兵当成 claude 内置的只读投影（停不掉、没日志）。改它得迁库、所有客户端同步换，
 * 而且回退旧版时新写的行它全认不出 —— 用户却从来看不到这个值（页面上写的是「Navi 哨兵」）。所以冻结。
 * 拆：不拆；哪天要动，先写库迁移并让客户端两种值都认。
 */
export const FROZEN_MONITOR_KIND_OWN = "ash";

/** codex 中转供应商 id。codex 把它记进会话存档，换了它，升级前的会话续跑时对不上供应商。拆：不拆。 */
export const FROZEN_CODEX_RELAY_PROVIDER_ID = "ash_relay";

/**
 * 配了准备命令的验收门禁，其测试快照所在的独立根（系统临时目录下 `<前缀><库路径摘要>`）。它不是用完
 * 即弃的临时目录：启动清扫、任务了结时回收、收尾核验都按这个根去找升级前留下的快照；而且根的路径
 * 进了门禁的环境摘要（`accept-gate-deps.ts` 的 ambientDigest），换了它，所有「跑过就沿用」的通过
 * 记录在升级那一刻一起失效、全部重跑。用户看不见它（要挪用 `NAVI_GATE_ISOLATED_DIR`），所以冻结。
 * 拆：不拆。
 */
export const FROZEN_GATE_ISOLATED_DIR_PREFIX = "ash-accept-gate-";

/**
 * 多人模式下没填 git 邮箱的用户，替他署名用的默认域名（`<目录名>@ash.local`）。这些用户此前的每一个
 * 提交都署着它；换了它，同一个人在 git log / blame / 代码托管的作者映射里从升级那天起变成两个人。
 * 设置页给出的建议值也必须是它（建议值就是不填时的实际值）。拆：给空邮箱的用户补写一次显式邮箱之后。
 */
export const FROZEN_DEFAULT_GIT_EMAIL_DOMAIN = "ash.local";

/**
 * 合成「任务改动的对比基准」提交时用的落款与说明（`task-change-scope.ts`）。日期也是写死的，目的就是
 * 同样的两边永远合出同一个提交号 —— 审查提示、报告里引用的对比基准靠这个号前后对得上。换了落款，
 * 同一个基准升级前后是两个提交号。这个提交没有引用指着、用户看不到，所以冻结。拆：不拆。
 */
export const FROZEN_SYNTHETIC_COMMIT_NAME = "ash";
export const FROZEN_SYNTHETIC_COMMIT_EMAIL = "ash@localhost";
export const FROZEN_SYNTHETIC_COMMIT_MESSAGE = "ash: 任务改动的对比基准";

// ── 只写新名、没有旧名读取方的落盘字样（不在这里定义，列出来备查）──────────────────────────
//
// 下面这些在改名时直接换成了新名：旧名产物只是升级前留下的、谁都不再按名字去找的东西，所以不认旧名。
//  · CLI 配置发布的备份 `.bak-navi-setup`（升级前留下的 `.bak-ash-setup` 原样留在用户手里，没人删它）
//    与预演文件 `.navi-publish-probe-`：`scripts/config-publish.mjs`、`server/src/auth/config-publish.ts`；
//  · 原生验收工具的编译缓存 `navi-accept-gate/`（按源码摘要命中，换目录只是重编一次）；
//  · 用完即删的临时目录：`navi-merge-preview-`、`navi-sealed-`、`navi-accept-`、`navi-worktree-recovery-`、
//    `navi-preview-trial-`、`navi-regression-index-`、`navi-base-update-`、`navi-chat-`、`navi-setup-codex-`、
//    `navi-mcp-ask-`；
//  · Windows 重启终止脚本的回复行 `NAVI_RESTART_*`（同一次调用生成、同一次调用解析）；终端停止命令的
//    圈定记号 `stop-<id>`（只活在那条命令的生命期里）；
//  · Navi 替任务落款的提交身份 `navi <navi@localhost>`（`server/src/navi-commit-identity.ts`，提交带真实时间，
//    已写下的提交不改写）；
//  · 模型目录请求的 User-Agent `navi/model-catalog`、中转诊断错误码 `NAVI_*`（同一进程里产生和消费）、
//    终端包装壳的 `$0` `navi-terminal`、分发包名 `navi-<日期>-<版本>`；
//  · claude 模型探测的 `control_request` 请求号 `navi_models_1`（同一次探测里发出、回执不按它对）；
//  · 验收移动分支时写进用户仓库 reflog 的说明 `navi accept: <来源分支>`（没有读取方）。
//
// 不算约定、所以没动的：只活在本进程一个数据库连接里的 TEMP 触发器与自定义函数名（`ash_actions_*`），
// 生成器内部占位符、shell 函数名、内部 Symbol、进程内派发用的假域名，以及测试入口的环境变量。
