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

/** codex 中转供应商 id。codex 把它记进会话存档，换了它，升级前的会话续跑时对不上供应商。拆：不拆。 */
export const FROZEN_CODEX_RELAY_PROVIDER_ID = "ash_relay";
