// ── 任务接力（跨机器 handoff）──────────────────────────────────────────────
// 把一个任务连同 git 分支、CLI 会话文件、会话产物整体迁到另一台 ash 上续跑。
// 从 index.ts 拆出的纯类型模块;index.ts 做类型再导出,消费方 import 路径不变。
import type { TaskStage, TaskStatus } from "./index.ts";

export interface HandoffTarget {
  name: string;
  url: string;
  // 这台目标机的公钥指纹(sha256 hex),第一次明确申请或接力成功后记住(TOFU)。
  // 之后每次预检/导出都拿对端现报的指纹跟它比,对不上就**拒绝打包** —— 接力推的是
  // 整个仓库和会话历史,地址漂到别人机器上时,这是唯一拦得住的东西。
  // 空/缺失 = 还没记过(首次)或用户手动清除过。
  peerFp?: string | null;
}

// ── 接力身份与配对 ─────────────────────────────────────────────────────────
// 一台 ash = 一对 ed25519 密钥。指纹是公钥的 sha256,公开可传;私钥不出机器。
// 为什么不是一把共享 key,见 server/src/handoff-identity.ts 顶部。

/** GET /handoff/identity:本机身份(设置页展示,供另一台机器核对)。 */
export interface HandoffIdentity {
  fingerprint: string;
  /** 给人看的短指纹,5 组 4 位 hex。 */
  short: string;
  host: string;
}

/** 入站信任表的一行:哪台机器可以把任务接力**进**本机。 */
export interface HandoffPeer {
  fingerprint: string;
  short: string;
  /** 对端自述的主机名,不可信,只帮人认出是哪台。 */
  name: string;
  status: "pending" | "approved" | "blocked";
  firstSeenAt: string;
  lastSeenAt: string;
  approvedAt: string | null;
  /** 最近一次来访地址,纯展示。 */
  lastAddr: string;
  /** true = 仅为撤销历史回程权限而建立的拒绝记录，并不代表这台机器曾申请整机接力。 */
  returnOnly: boolean;
}

/** 历史 out 存档授予的任务级回程权限；它不等于整机入站批准。 */
export interface HandoffReturnGrant {
  fingerprint: string;
  short: string;
  name: string;
  taskCount: number;
  lastGrantedAt: string;
  blocked: boolean;
}

/** 无法核验对端时由用户显式承担双任务风险的持久审计记录。 */
export interface HandoffAudit {
  kind: "forced-recovery";
  at: string;
  returning: boolean;
  peerName: string | null;
  forceReason: "legacy" | "unreachable" | "identity" | "unverifiable";
}

/** 预检时对目标机做的身份核对结果(出站方向)。 */
export interface HandoffPeerIdentity {
  fingerprint: string;
  short: string;
  // matched    = 和设置里记住的指纹一致
  // first-seen = 还没记过,这次接力成功后记住(TOFU)
  // mismatch   = 记过但对不上 —— 预检和导出都硬拒绝
  // legacy     = 对端没报身份(版本过旧),无法核对
  trust: "matched" | "first-seen" | "mismatch" | "legacy";
  // 对端对本机的态度(入站方向,由对端自述):
  // approved 放行 / pending 待批准 / blocked 已拒绝 / open 对端没开审批 / unknown 旧版对端
  peerStatus: "approved" | "pending" | "blocked" | "open" | "unknown";
  /** mismatch 时:设置里记住的那个短指纹,摆出来给用户核对。 */
  expectedShort?: string | null;
  /** 这次接力的载荷会不会加密传输(对端支持 + 本机没在设置里关掉)。 */
  encrypted?: boolean;
  /** 对端**有没有能力**收加密载荷。false 时 encrypted 一定是 false,原因是对端太旧。 */
  canEncrypt?: boolean;
}

/** POST /handoff/request:显式向目标机发送接力申请并读取对方当前态度。 */
export interface HandoffApprovalResult {
  ok: true;
  target: { url: string; host: string };
  /** null = 对端版本过旧，没有可核对的机器身份。 */
  peer: HandoffPeerIdentity | null;
  /** 只有对方已经接受申请（或关闭审批）时才会返回项目。 */
  projects: HandoffPingProject[];
}

// 落在 tasks.handoff（json）上的持久接力标记:导出侧 direction:"out"（任务已交出去，
// 本地这份只是历史），首次导入侧 direction:"in"（在别人机器上帮原机继续），安全移回
// 原机后 direction:"returned"（只保留历史/幂等信息，不再限制下一次接力目标）。
export interface TaskHandoff {
  direction: "out" | "in" | "returned";
  // out 专用:true = 请求已发出但没收到对端确认(应答丢失/源机中途退出)。pending 态
  // 同样硬拦本机启动;原样重试接力会按 transferId 幂等收口,确认没送到也可手动移除标记。
  pending?: boolean;
  // 这一次接力的身份证(源机生成并持久化,导入侧存进 in 标记):重试时对端据此把
  // 「已有同 id 任务」识别成同一次接力。老版本导出的标记没有这个字段。
  transferId?: string | null;
  // out+pending:存在这个字段表示这是一次“移回”的送达未知态，值是原始 out 存档的
  // transferId；returned:保留同一凭据，供移回应答丢失后的任务级 ping/import 幂等收口。
  // 字段存在而值为 null 也有意义：代表旧记录的移回意图，不能退化成普通接力。
  returnTransferId?: string | null;
  // out:对端项目 id,供横幅生成带项目与任务的完整直达链接。pending 时还用于冻结
  // 第一次发送参数:收口重试只能对同一台机器、同一个项目原样重放。
  targetProjectId?: string | null;
  // out+pending:冻结的重放参数(见上)。in:导入时有没有触发自动续跑,幂等收口
  // 应答靠它如实报当初的事实。老标记没有这个字段。
  autoResume?: boolean;
  // out+pending 专用:第一次发送的 manifest 里带走的待发送消息 id。收口成功后只取消
  // 这一批——pending 期间新建的消息没有随幂等重放迁移到对端,必须留在托盘里如实提醒,
  // 按「当前所有 pending」取消就是静默丢消息。
  messageIds?: string[];
  // out: 对端 ash 根地址；in:接入时由真实来源地址 + 源机监听端口恢复出的回程候选地址。
  // 地址只用于连接，移回仍会按 peerFp 实时验明身份。
  peerUrl: string | null;
  // out: 目标配置里的名字；in: 源机主机名。
  peerName: string | null;
  // in:签名确认过的来源机器指纹。移回时只允许选择 handoffTargets 里指纹一致的机器，
  // 防止把「移回」变成任意第三台机器的再次转送。returned 只用它展示移回来源；不锁目标。
  // 老版本导入没有此字段。
  peerFp?: string | null;
  // 任务最初创建所在机器的指纹。它随每次接力原样传播；只有接收机指纹等于它时，
  // 覆盖历史存档才算真正“回到原机”并写 returned。旧记录缺失时按当前方向保守推断。
  originFp?: string | null;
  // 对端那份任务的 id（同 id 迁移,当前恒等于本任务 id;留字段防语义变化）。
  peerTaskId: string;
  at: string;
  // 成功搬运的 CLI 会话文件数。0 = 对端只能全新起跑（吃一遍任务正文）。
  sessions: number;
  // 代码是否随任务走了:bundle = 分支打包带走;none = 没有可带的（非 worktree 任务等）。
  git: "bundle" | "none";
  note?: string;
}

// 对端 /handoff/ping 报出的候选项目（接力对话框里选目标项目用）。
export interface HandoffPingProject {
  id: string;
  name: string;
  repoPath: string;
  isRepo: boolean;
}

// POST /tasks/:id/handoff/preflight 的应答:探测对端 + 盘点本地可搬运的东西,只读。
export interface HandoffPreflightResult {
  ok: true;
  target: { url: string; host: string };
  /** true = 本次移回仍使用任务存档限定的免审批通道；false = 普通接力或已降级为普通接力。 */
  taskScopedReturn: boolean;
  /** 对目标机做的身份核对(出站方向)。null = 对端连 ping 都没报身份且本机也没记过。 */
  peer: HandoffPeerIdentity | null;
  projects: HandoffPingProject[];
  // 按仓库目录名匹配出的对端项目;null = 没匹配上,让用户自己选。
  suggestedProjectId: string | null;
  local: {
    status: string;
    running: boolean;
    sessions: number;
    sessionFilesFound: number;
    // 任务文本/会话产物里引用的上传附件(data/uploads)数,接力时随任务打包并改写路径。
    uploads: number;
    // 待发送/排队消息(scheduled_messages)数,随任务迁移,到期后在对端投递。
    pendingMessages: number;
    // 任务的定时计划(schedules):随任务迁移,今后由对端触发;null = 没有计划。
    schedule: "once" | "cron" | null;
    git: "bundle" | "none";
    notes: string[];
  };
}

// POST /tasks/:id/handoff 的应答。
export interface HandoffExportResult {
  ok: true;
  remoteTaskId: string;
  remoteUrl: string;
  sessionsMigrated: number;
  git: "bundle" | "none";
  autoResume: boolean;
  notes: string[];
}

// ── 出站存档的实时状态 ─────────────────────────────────────────────────────
// 接力出去之后，本机那一行的 status 就停在**交出去那一刻**（导出前会先停掉任务，所以
// 多半是 canceled/idle）。对端后来跑没跑完、有没有卡在提问上，本机一个字都不知道。
// 侧栏要把这些行跟本机任务同等对待（同一份列表、同一套状态点和筛选），前提就是先把
// 真状态问回来 —— 否则等于把一批冻住的假状态铺在最该可信的那个列表里。
//
// 一次一台机器批量问，只回状态不回会话内容（会话仍走按需的 remote-snapshot）。
export interface HandoffRemoteState {
  /** 对端任务 id（同 id 迁移，等于本机这一行的 id）。 */
  taskId: string;
  status: TaskStatus;
  stage: TaskStage | null;
  question: string | null;
  title: string;
  updatedAt: string;
}

/** 联系不上的持有机：这台机器上的出站行只能显示接力当时的旧状态，得如实说出来。 */
export interface HandoffPeerOffline {
  url: string;
  name: string;
  reason: string;
}

/** POST /tasks/outbound-state（浏览器面）的应答。 */
export interface HandoffOutboundStateResult {
  rows: HandoffRemoteState[];
  offline: HandoffPeerOffline[];
}
