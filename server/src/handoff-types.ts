// 任务接力——两端共用的传输协议类型、错误类与尺寸常量(从 handoff.ts 拆出,
// 导出/导入/HTTP 面三处共用;业务流程见 handoff.ts 顶部注释)。
import { isAbsolute } from "node:path";
import type { HandoffPingProject } from "@ash/shared";

export class HandoffError extends Error {
  // 导入侧专用:true = 这次失败**不证明**本机没留下半截产物(补偿回滚自身失败)。
  // HTTP 面据此决定应答上还带不带「可证明业务拒绝」的 ash 标记——不带,源机就会
  // 按「送达未知」保留 pending,不敢在本机重新起跑。
  unsettled = false;
  // network=true:请求没送达或应答没读全 —— 对端**可能已经**处理成功,调用方不能
  // 当「确认失败」处理(exportHandoff 靠它决定保留 pending 标记还是回滚)。
  // remoteStatus / remoteAsh 只由 fetchPeer 填：兼容逻辑据此区分「旧版没有这个路由」
  // 和「新版路由明确返回业务错误」，避免靠错误文案做宽泛匹配。
  remoteStatus: number | null = null;
  remoteAsh = false;
  constructor(message: string, public status: number = 400, public network = false) {
    super(message);
  }
}

export interface HandoffFilePayload {
  // rel 一律用 `/` 作分隔符(源机是 Windows 也一样,导出侧负责归一;导入侧按段重新
  // join 成本平台路径)。claude-session 的 rel 是 `<cliSessionId>.jsonl`（不含目录,
  // 目的目录由对端按它自己的 cwd 重新算 slug）;codex-rollout 是相对
  // <codexHome>/sessions 的路径（日期目录结构原样保留,codex 按后缀扫描,放哪天的
  // 目录都找得到）;run-artifact 是相对 data/runs/<taskId>/ 的路径。
  kind: "claude-session" | "codex-rollout" | "run-artifact";
  rel: string;
  dataBase64: string;
}

// 任务文本/会话文件里被引用的上传附件(data/uploads 下的文件)。收集与改写逻辑在
// handoff-uploads.ts。
export interface HandoffUploadPayload {
  // uploads 目录直下的文件名(id()+净化名生成,字符集 [A-Za-z0-9._-],无目录成分)。
  name: string;
  // 源机上的绝对路径:导入侧据此把各处文本里的旧路径改写成本机新路径。
  sourcePath: string;
  dataBase64: string;
}

// 任务的待发送/排队消息(scheduled_messages 表),只带 status=pending 的行——它们在
// 源机永远投不出去(接力守卫拦续跑),不迁移就是用户已提交消息的永久丢失(第 2 轮审查
// 实测)。不带 id(导入侧重新生成)、不带 executorId(源机 agents 表外键,对端没有意义,
// 按 agent 类型默认执行器解析)、不带 status/sentAt/deliveringSince(导入即 pending)。
export interface HandoffMessagePayload {
  text: string;
  // JSON string[]:上传附件的源机绝对路径,导入侧按 JSON 上下文改写成本机路径。
  attachments: string;
  agent: string | null;
  model: string | null;
  reasoningEffort: string | null;
  sessionRole: string | null;
  mode: string; // timed | queued
  sendAt: string;
  createdAt: string;
}

// 任务的定时计划(schedules 表)。lastRunAt/enabled 原样带走:触发过的一次性计划
// enabled=false,不会在对端重新触发;不带 id(导入侧重新生成)。
export interface HandoffSchedulePayload {
  kind: string; // once | cron
  at: string | null;
  cron: string | null;
  enabled: boolean;
  lastRunAt: string | null;
}

export interface HandoffSessionRow {
  id: string;
  role: string;
  agentType: string;
  executor: string;
  turnModel: string | null;
  turnReasoningEffort: string | null;
  worktreePath: string | null;
  branch: string | null;
  cwd: string | null;
  // 对端只保留「会话文件真的搬过去了」的 cliSessionId,其余置空——否则 --resume
  // 一个不存在的会话,CLI 当场报错,比全新起跑更糟。
  cliSessionId: string | null;
  commandLine: string | null;
  startedAt: string;
  endedAt: string | null;
  exitStatus: number | null;
  stoppedAs: string | null;
  sideTurn: boolean;
  activeMs: number | null;
  turnStartedAt: string | null;
  usageInput: number | null;
  usageOutput: number | null;
  usageCacheRead: number | null;
  usageCacheWrite: number | null;
  usageReasoning: number | null;
  usageCostUsd: number | null;
  usageTurns: number | null;
  contextUsed: number | null;
  contextWindow: number | null;
  contextWindowEstimated: boolean | null;
}

export interface HandoffManifest {
  version: 1;
  sourceHost: string;
  // 源 ash 的监听端口。接收机只把它和真实 TCP 来源地址组合成回程候选地址；回程前仍会
  // 用任务里钉住的公钥指纹做双向核对，所以地址被改写也拿不到任务载荷。
  sourcePort?: number | null;
  // 源机身份指纹；manifest 整体有签名保护。老版本没有，导入照常接受但无法安全“移回”。
  sourceFingerprint?: string | null;
  // 任务原机指纹；每一跳原样传播，接收侧据此区分“回到原机”和“再次交给曾持有机器”。
  originFingerprint?: string | null;
  targetProjectId: string;
  // 这一次接力的身份证:源机在发送前生成并持久化。应答丢失后重试会带**同一个**
  // transferId,导入侧据此把「已有同 id 任务」识别成同一次接力并幂等返回成功。
  transferId: string;
  // 从接入任务移回时，带上上一跳的 transferId，原机据此把免审批通道收窄到同一条历史存档。
  returnTransferId?: string | null;
  // 导入完成后要不要立刻在对端续跑（会真的拉起一个 agent）。
  autoResume: boolean;
  // 源机的工作目录（会话行里的 cwd 基准）,对端用它写「路径从 X 迁到 Y」的前言。
  sourceWorkspace: string | null;
  // 列名与 tasks 表对齐,JSON 列保持字符串原样,导入侧直接落库。
  task: {
    id: string;
    title: string;
    body: string;
    status: string;
    stage: string | null;
    labels: string;
    agentType: string | null;
    model: string | null;
    reasoningEffort: string | null;
    autoTitle: boolean;
    useWorktree: boolean;
    worktreeBase: string | null;
    workflow: string | null;
    workflowMode: string;
    workflowAt: string | null;
    reviewStep: string | null;
    verifyRounds: number;
    verifyStationRounds: number;
    resumePrompt: string | null;
    question: string | null;
    questionOptions: string | null;
    questionItems: string | null;
    pinnedAt: number | null;
    starredAt: number | null;
    createdAt: string;
    startedAt: string | null;
    endedAt: string | null;
  };
  sessions: HandoffSessionRow[];
  // 被任务文本/会话文件引用的上传附件。老版本导出的 manifest 没有这个字段。
  uploads?: HandoffUploadPayload[];
  // 待发送/排队消息与定时计划。老版本导出的 manifest 没有这些字段。
  messages?: HandoffMessagePayload[];
  schedule?: HandoffSchedulePayload | null;
  git: null | {
    branch: string;
    head: string;
    // full = 没协商出公共前置提交,bundle 含分支全部历史（体积大但独立可用）。
    full: boolean;
    prereqs: string[];
    // 空串 = 对端已有分支全部提交,不传数据,导入侧只把分支对齐到 head。
    bundleBase64: string;
  };
  files: HandoffFilePayload[];
}

export interface HandoffPingResponse {
  ok: boolean;
  service: string;
  host: string;
  // 对端的机器身份。老版本 ash 没有这个字段 —— 源机据此判定「无从核对」并如实提示。
  // sig 是用私钥对源机 nonce 的签名:公钥是公开的,只报公钥证明不了持有私钥。
  // kxPublicKey 是传输加密用的 X25519 公钥,老版本没有 —— 源机据此判定这次能不能加密。
  identity?: { publicKey: string; fingerprint: string; sig: string; kxPublicKey?: string };
  // 对端对**源机**的态度(入站方向):approved 放行 / pending 待批准 / blocked 已拒绝 /
  // open 对端没开审批 / unknown 源机没签名或对端是旧版。
  peerStatus?: "approved" | "pending" | "blocked" | "open" | "unknown";
  // 对端是单人还是多人实例(§十一「审批必须知情」)。多人时附用户数。老版本没有这个
  // 字段 —— 源机读到 undefined 就按「单人/旧版」处理,与本功能上线前一致。
  instanceMode?: "single" | "multi";
  userCount?: number;
  // 多人实例专用:这次请求带的那把对端 key 认出来是谁。没带/不认时为空,源机据此
  // 提示「去配 key」而不是把空项目列表当成「对端没有项目」。
  peerUser?: { id: string; name: string } | null;
  // 未获批准时故意为空:项目清单是本机的仓库布局,不该报给还没被认可的机器。
  projects: HandoffPingProject[];
  // 任务级免审批移回时，只返回该任务原项目的 refs，供持有机生成增量 bundle。
  returnRefs?: { name: string; commit: string }[];
}

/** 相对路径必须待在自己的目录里:拒绝绝对路径和 `..`（导入侧写盘前的通行证）。 */
export function safeRel(rel: string): boolean {
  if (!rel || isAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).some((seg) => seg === ".." || seg === "");
}

export const MB = 1024 * 1024;
// 单个会话文件/产物文件超过这个就跳过（留 note）,总包超过就拒绝——JSON base64 全量
// 进内存,别让一个巨型仓库把两边进程都压死。
export const MAX_FILE_BYTES = 100 * MB;
export const MAX_BUNDLE_BYTES = 300 * MB;
