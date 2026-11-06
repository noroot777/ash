// IM 通道（飞书）的前后端契约。方案见 docs/feishu-integration.md。
//
// 凭证只写不读：状态里只回 appId 和「配没配」，App Secret 永远不出 server。

export type ImDomain = "feishu" | "lark";

/**
 * 连接状态。前几档是「根本没去连」的原因，后几档是长连接自己的状态：
 *   unconfigured  没配凭证
 *   broken        凭证文件坏了（原因在 configError）
 *   preview       预览实例，按设计不连
 *   not_exclusive 同一个库起了多个实例（ASH_ALLOW_MULTI），连上会和另一个实例随机分走事件
 *   disabled      总开关关着
 */
export type ImConnectionState =
  | "unconfigured" | "broken" | "preview" | "not_exclusive" | "disabled"
  | "idle" | "connecting" | "connected" | "reconnecting" | "failed";

/** 免登录的 `/api/health` 只放这一档投影，不带任何标识或错误原文。 */
export type ImHealthState = "off" | "connecting" | "connected" | "reconnecting" | "failed";

/** 花额度的调用种类。降级时按「最不要紧的先砍」：reaction → patch → info → send。 */
export type ImApiKind = "token" | "send" | "patch" | "reaction" | "download" | "info";

/**
 * 本月额度水位：
 *   normal     照常
 *   frugal     ≥70%：不加「已收到」表情
 *   essential  ≥90%：只发决策卡（提问/待验收/失败/驳回/闸口）和对话回复，不发通知、不改旧卡
 *   exhausted  ≥99%：除了改卡回写本次点击的结果，什么都不发
 */
export type ImQuotaLevel = "normal" | "frugal" | "essential" | "exhausted";

export interface ImUsage {
  /** 自然月，北京时间，形如 2026-11。 */
  month: string;
  calls: number;
  quota: number;
  level: ImQuotaLevel;
  byKind: Partial<Record<ImApiKind, number>>;
}

export interface ImOptions {
  /** 总开关。关掉 = 断开长连接，机器人下线。 */
  enabled: boolean;
  /** 任务完成/验收合并/门禁出结果也推一条通知（默认开）。 */
  notifyCompleted: boolean;
  /** 卡片里「在 ash 中打开」的地址前缀，如 Tailscale 地址；为空则卡片不带深链。 */
  publicBaseUrl: string | null;
  /** 飞书开放平台的月调用额度（免费版自建应用 1 万次）。 */
  monthlyQuota: number;
  /** 这些项目的卡片只推标题和链接，不推提问正文、失败原因。 */
  titleOnlyProjectIds: string[];
}

export interface FeishuConnection {
  state: ImConnectionState;
  since: string | null;
  connectedAt: string | null;
  lastEventAt: string | null;
  /** 已脱敏、截断。 */
  error: string | null;
  reconnectAttempts: number;
  botName: string | null;
}

export interface FeishuStatus {
  /** 能不能改凭证与实例级选项（自用模式恒为 true；多人模式只有管理员）。 */
  canManage: boolean;
  multiUser: boolean;
  config: { appId: string; domain: ImDomain; updatedAt: string } | null;
  configError: string | null;
  connection: FeishuConnection;
  options: ImOptions;
  /** 非管理员拿到 null。 */
  usage: ImUsage | null;
  /** 本机实例指纹（短），与「实例已上线」消息里同一串，用来发现两台机器连了同一个应用。 */
  instanceTag: string;
  /** 发件表里还没发出去 / 已放弃的条数。非管理员拿到 null。 */
  outbox: { pending: number; dead: number } | null;
}

/** 本人与飞书的绑定。状态以服务端为准，刷新页面后仍能看出走到了哪一步。 */
export type FeishuBinding =
  | { state: "none" }
  | { state: "code"; codeId: string; expiresAt: string }
  | { state: "pending"; codeId: string; openIdTail: string; claimedAt: string; expiresAt: string }
  | {
    state: "bound";
    appId: string;
    openIdTail: string;
    boundAt: string;
    /** 绑定时的应用与当前凭证不是同一个：换过应用，需要重新绑定。 */
    stale: boolean;
    /** 「当前项目」：飞书里派任务、/new 落在哪个项目。 */
    projectId: string | null;
  };

/** 生成绑定码的回应。明文码只在这一次回给页面，库里只存哈希。 */
export interface ImBindCode {
  codeId: string;
  code: string;
  expiresAt: string;
}

export interface FeishuGroup {
  chatId: string;
  name: string | null;
  projectId: string;
  boundAt: string;
  /** 本项目任务的卡片改发到这个群（话题里回复 = 回复任务），而不是发到个人单聊。 */
  pushCards: boolean;
  /** 卡片此刻真的发到这个群：同一个项目好几个群都开着推送时，只有最近绑的那个收。 */
  receiving: boolean;
  /** 谁绑的（显示名）。 */
  boundBy: string | null;
  /** 看的人能不能改、解绑这个群（绑它的人本人或实例管理员）。 */
  canEdit: boolean;
}

export interface FeishuGroupClaim {
  codeId: string;
  projectId: string;
  /** 群里有人 @ 机器人发来了这串码之后才有。 */
  chatId: string | null;
  name: string | null;
  claimedAt: string | null;
  expiresAt: string;
}

export interface FeishuGroups {
  groups: FeishuGroup[];
  claims: FeishuGroupClaim[];
}
