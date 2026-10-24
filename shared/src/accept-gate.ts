// 「验收前置命令」(accept gate) —— 点验收那一刻才跑的那条命令。
//
// 由来(用户 2026-10-23):跑全量回归这类重活,约定写的是「代码进 main 之前至少跑一次」。
// 可有审查者在场时,**没人知道哪一轮是最后一轮** —— agent 只能每轮收尾都跑一遍,用 N 次
// 12 分钟去对冲一个只发生一次的事件。而「进 main」这条边界在 ash 里恰好有一个确定的时刻:
// 用户点验收。把命令钉在那一刻,语义更准,一次也不浪费。
//
// 判据只有一条:**rc=0 才合并**。非 0 不合并、不清理、目标分支一个字节不动,日志回流给
// agent 去修 —— 跟「验收撞冲突叫醒 agent」是同一套退路。
//
// 跑的是**任务已提交源码的独立快照**。fast-forward 时它就是合并结果;目标分支此后前进过,
// 被测树就不等于合并结果 —— 那时只如实记一行,不拦(活跃仓库上拦就是永远验收不了)。
export type AcceptGateStatus = "running" | "passed" | "failed" | "interrupted" | "canceled";

/** 没通过时具体是哪一种没通过。日志之外,用户第一眼读的就是这个。 */
export type AcceptGateFailure = "exit_code" | "timeout" | "spawn_failed" | "server_restarted" | "canceled" | "source_changed" | "process_unconfirmed" | "ownership_waived";

export const ACCEPT_GATE_STATUS_LABELS: Record<AcceptGateStatus, string> = {
  running: "正在跑",
  passed: "通过",
  failed: "未通过",
  interrupted: "被打断",
  canceled: "已取消",
};

export const ACCEPT_GATE_FAILURE_LABELS: Record<AcceptGateFailure, string> = {
  exit_code: "命令退出码非 0",
  timeout: "超时",
  spawn_failed: "命令起不来",
  server_restarted: "ash 重启,这次没跑完",
  canceled: "你取消了这一次",
  source_changed: "测试修改了被测源码，不能用结果为原版本放行",
  process_unconfirmed: "尚未取得整次运行退出的证据",
  ownership_waived: "已确认风险并强制释放，未取得整次退出证据",
};

export interface AcceptGateView {
  id: string;
  taskId: string;
  /** 跑的那条命令原文(项目设置里改过的话,这里仍是**这一次**用的那条) */
  command: string;
  /** 在哪儿跑的 */
  cwd: string;
  status: AcceptGateStatus;
  exitCode: number | null;
  failure: AcceptGateFailure | null;
  startedAt: string;
  finishedAt: string | null;
  /** 被测的那棵树:任务工作区当时的 HEAD。它一变,这次结果就不再算数 */
  sourceCommit: string | null;
  /** 当时的目标分支与它的 HEAD(非 worktree 任务没有合并目标,两者都是 null) */
  targetBranch: string | null;
  targetCommit: string | null;
  /** 当时合并会不会是纯 fast-forward。false = 被测树 ≠ 合并结果,只提示不拦 */
  fastForward: boolean | null;
  stale: boolean;
  logPath: string;
  logAvailable?: boolean;
  /** 日志末尾若干行,够在界面上一眼看出红在哪 */
  logTail: string;
  /**
   * 这一次的红交没交回给 agent 去修。null = 没交过(通过/取消/被打断都不交)。
   * `error` 非空 = 那一次没能叫醒它(回合被抢占、任务被归档之类),红还在那儿等人处理。
   */
  handoff: { at: string; error: string | null } | null;
  processPending?: boolean;
}

export type AcceptGateCancelResult = {
  outcome: "canceled" | "already_finished" | "stopping" | "not_running" | "settlement_failed";
  runId: string | null;
  gate: AcceptGateView | null;
};

export function acceptGateCancelMessage(result: AcceptGateCancelResult): string {
  if (result.outcome === "settlement_failed") return "取消结果保存失败，尚未完成结算；请重试取消，工作区仍受保护";
  if (result.outcome === "canceled") return "已取消这一次验收前置命令；重新验收时会重跑";
  if (result.outcome === "stopping") return "尚未确认整棵进程树退出，工作区仍被占用；不能合并或清理";
  if (result.outcome === "already_finished") return "这一次命令已经结束，未执行取消；验收是否完成请以当前回执为准";
  return "当前没有正在跑的验收前置命令，未执行取消";
}

/** 这条命令最多跑多久。再久基本是卡住了 —— 出路是验收台上那颗「取消」。 */
export const ACCEPT_GATE_TIMEOUT_MS = 90 * 60_000;

/** 回显给界面和 agent 的日志尾巴长度。全文走单独的接口。 */
export const ACCEPT_GATE_TAIL_BYTES = 4000;

/**
 * 「看完整日志」最多给多少字节。全量回归的输出能有几十 MB，而那一头是**整份读进内存、
 * 再整份塞进一个 `<pre>`**：服务端顶一次，浏览器卡一次，而用户真正要看的永远是尾巴。
 * 超过就只给最后这一段，并在开头说破「前面还有多少没给你」。
 */
export const ACCEPT_GATE_LOG_MAX_BYTES = 512_000;

export const MAX_ACCEPT_GATE_COMMAND = 4000;

/**
 * 归一化用户填的那条命令。空串/空白/null 一律是「这个项目不设门禁」—— 只存一种写法,
 * 读侧才不用在 `""` 和 `null` 之间猜。
 *
 * 不校验命令本身能不能跑:它是一条交给用户自己 shell 的命令行(预览命令同款口径),
 * 跑不起来由那一次门禁如实报 spawn_failed,而不是在设置页拦着不让存。
 */
export function normalizeAcceptGateCommand(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const cmd = input.trim();
  if (!cmd || cmd.includes("\0") || cmd.length > MAX_ACCEPT_GATE_COMMAND) return null;
  return cmd;
}

/** 一句人话的状态摘要,toast / 时间线 / agent 回流共用一份措辞。 */
export function summarizeAcceptGate(gate: AcceptGateView): string {
  const head = `验收前置命令 \`${gate.command}\``;
  if (gate.status === "running") return `${head} 正在跑`;
  if (gate.status === "passed") return `${head} 通过（rc=0）`;
  const why = gate.failure ? ACCEPT_GATE_FAILURE_LABELS[gate.failure] : "未通过";
  return `${head} ${ACCEPT_GATE_STATUS_LABELS[gate.status]}：${why}${
    gate.exitCode !== null && gate.failure === "exit_code" ? `（rc=${gate.exitCode}）` : ""
  }`;
}

/**
 * **这一次验收**拿什么当凭据放的行。
 *
 * 为什么必须单独记一份、而不能拿「最近一次门禁结果」反推(第 1 轮审查 F1 实测):那两件
 * 事根本不是一回事 —— 命令在 A 上跑绿、代码又改成了 B、项目再把命令撤掉,此时「最近一次」
 * 仍然是那条绿的,而真正放行的理由是「现在没有门禁」。照最近那一次说话,回执就会把一份
 * 从没测过的代码写成「合并前已通过测试」,那是这功能最不该出的错。
 *
 *  - `passed`  这一按是拿一次真的跑绿放行的(`runId` 指着那一次,**不是**最近那次)
 *  - `skipped` 用户在验收时明确选了跳过:没跑,也没有任何通过的证据
 *  - `unset`   那一刻这个项目根本没设门禁(撤掉了、或从来没设)
 */
export type AcceptGateBasisMode = "passed" | "skipped" | "unset";

export type AcceptGateBasis = {
  mode: AcceptGateBasisMode;
  /** `passed` 时那一次的完整记录;记录被清掉(归档清理)或非 passed 时为 null。 */
  run: AcceptGateView | null;
};

/** GET /tasks/:id/accept-gate:这个项目设没设门禁、现在跑没跑、上一次跑成什么样。 */
export type AcceptGateState = {
  unavailable?: string | null;
  sourceError?: string | null;
  /** 项目设置里的那条命令;null = 这个项目没设门禁。 */
  command: string | null;
  running: AcceptGateView | null;
  /** 最近一次(可能就是 running 那条)。**不是本次验收的凭据**,见 basis。 */
  latest: AcceptGateView | null;
  /**
   * 已经验收过的任务:那一按**实际**拿什么放的行。null = 还没验收,或是没留凭据的老数据
   * (老数据如实显示「没留下凭据」,不拿 latest 冒充)。
   */
  basis: AcceptGateBasis | null;
};
