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
// 被测树就不等于合并结果 —— 默认档只如实记一行,不拦;要拦、或者要测合并结果,由项目在
// 「门禁基准」(AcceptGateBaseline)里自己选。
export type AcceptGateStatus = "running" | "passed" | "failed" | "interrupted" | "canceled";

/**
 * 门禁基准：这条命令**测的是哪一棵树**。项目级设置（projects.accept_gate_baseline），验收台上
 * 那张门禁卡和「项目设置 → 验收」改的是同一个字段。
 *
 * 由来（2026-11-02 的撞车）：两个并行任务一个把回调改了名、一个还在用旧名，开工基线都早于对方，
 * 各自在**自己分支的快照**上跑门禁全绿，先后合进 main 之后 main 编译红 —— 合并之后那棵树没有
 * 任何一道测试跑到过。三档是三种不同的代价：
 *
 *  - `branch`          测任务分支那棵树（老行为，也是默认）。目标分支此后进来的改动不在被测范围内。
 *  - `contains_target` 只放行**已包含目标分支尖端**的任务分支：不含就在跑之前拒绝，让任务先把目标
 *                      分支合进来。被测的仍是分支那棵树，但此时它就是合并结果（fast-forward）。
 *  - `merge_preview`   在测试快照里先把最新目标分支合进任务分支（不动真仓库），门禁对**预演的合并
 *                      结果**跑；预演冲突就按冲突拒绝、不跑。绿了的复用凭据连目标分支尖端一起认：
 *                      跑的那十几分钟里目标分支又动了，旧绿不能拿来合新的目标分支。
 *
 * 只对**有合并目标**的验收生效（独立 worktree 的任务）；在项目目录里直接干活的任务没有「合并之后」
 * 这件事，三档都按分支快照跑。
 */
export type AcceptGateBaseline = "branch" | "contains_target" | "merge_preview";

export const ACCEPT_GATE_BASELINES: readonly AcceptGateBaseline[] = ["branch", "contains_target", "merge_preview"];

export const ACCEPT_GATE_BASELINE_LABELS: Record<AcceptGateBaseline, string> = {
  branch: "分支快照",
  contains_target: "要求已含目标分支",
  merge_preview: "合并预览",
};

/** 这一档对「点一下验收」意味着什么。两处入口共用这一句，别各写一份。 */
export function acceptGateBaselineEffect(mode: AcceptGateBaseline, target?: string | null): string {
  // 有具体分支名就当代码名词嵌进句子（两边留空格，紧跟全角标点那一侧不留）；没有（项目设置页）就用通称，不留空格。
  const t = target ? ` ${target} ` : "目标分支";
  if (mode === "contains_target") return `任务分支还没包含${t}的最新提交时直接拒绝验收，先让任务把${t}合进来；含了才在分支快照上跑门禁。`;
  if (mode === "merge_preview") return `先在测试快照里把最新的${t}合进任务分支，再对这份合并结果跑门禁；预演有冲突就不跑，按冲突交回任务去解。`;
  return `门禁跑在任务分支自己的快照上；${t.trimStart()}之后进来的改动不在被测范围内。`;
}

/** 认不出的一律回到 `branch`：这一位只能让门禁更严，绝不能因为一条脏数据悄悄换了被测的树。 */
export function normalizeAcceptGateBaseline(value: unknown): AcceptGateBaseline {
  return typeof value === "string" && (ACCEPT_GATE_BASELINES as readonly string[]).includes(value)
    ? value as AcceptGateBaseline : "branch";
}


/**
 * 没通过时具体是哪一种没通过。日志之外,用户第一眼读的就是这个。
 *
 * `entry_missing` 是唯一**没起跑**的那一档:命令点名的入口是一个具体文件,起跑前核到被测的
 * 这棵树里没有它(server/src/accept-gate-entry.ts)。npm 脚本那种核不准,照常起跑,不进这一档。
 * 旧记录里可能还存着撤掉的 `command_missing`,读的那几处都做了兜底。
 */
export type AcceptGateFailure = "exit_code" | "prepare_failed" | "launcher_failed" | "timeout" | "spawn_failed" | "server_restarted" | "canceled" | "source_changed" | "process_unconfirmed" | "ownership_waived" | "entry_missing";

export const ACCEPT_GATE_STATUS_LABELS: Record<AcceptGateStatus, string> = {
  running: "正在跑",
  passed: "通过",
  failed: "未通过",
  interrupted: "被打断",
  canceled: "已取消",
};

export const ACCEPT_GATE_FAILURE_LABELS: Record<AcceptGateFailure, string> = {
  exit_code: "命令退出码非 0",
  prepare_failed: "准备命令失败，测试没有开跑",
  launcher_failed: "门禁启动器出了错，分不清停在哪一段",
  timeout: "超时",
  spawn_failed: "命令起不来",
  server_restarted: "ash 重启,这次没跑完",
  canceled: "你取消了这一次",
  source_changed: "测试修改了被测源码，不能用结果为原版本放行",
  process_unconfirmed: "尚未取得整次运行退出的证据",
  ownership_waived: "已确认风险并强制释放，未取得整次退出证据",
  entry_missing: "入口不在被测的树里，没有起跑",
};

/**
 * 把存下来的 failure 归一到**当前**的联合里。认不出的(撤掉的 `command_missing`、将来再撤的
 * 任何一档)一律 null = 「未通过,没有具体分类」 —— 旧类别本身就是旧判据下的结论,不能靠
 * 字段还在就继续当事实。exit_code / timeout 这些是真实观测,照旧保留。
 */
export function normalizeAcceptGateFailure(value: unknown): AcceptGateFailure | null {
  // `Object.hasOwn` 而不是 `in`:`in` 连原型链一起认,`"toString"` 这种会被当成合法类别。
  return typeof value === "string" && Object.hasOwn(ACCEPT_GATE_FAILURE_LABELS, value)
    ? value as AcceptGateFailure : null;
}

export interface AcceptGateView {
  executionNotice?: string | null;
  id: string;
  taskId: string;
  /** 跑的那条命令原文(项目设置里改过的话,这里仍是**这一次**用的那条) */
  command: string;
  /** 这一次在快照里先跑的准备命令原文;null = 没配,依赖按老办法从工作区借 */
  prepareCommand?: string | null;
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
  /**
   * 合并预览档:这一次预演时并进来的目标分支提交。非空 = 被测的是「任务分支 + 它」的合并结果,
   * 不是分支那棵树;null = 分支快照(另两档与老记录都是)。
   */
  previewBase?: string | null;
  stale: boolean;
  logPath: string;
  logAvailable?: boolean;
  /** 日志末尾若干行,够在界面上一眼看出红在哪 */
  logTail: string;
  /**
   * 入口那件事的一句话(起跑前核到点名的入口不在被测的树里时才有):核得准的那一档说它不在、
   * 没起跑、目标分支上有没有;核不准的那一档只陈述起跑前看到的,不下结论。null = 没有可说的。
   * 由落盘的起跑前事实现算,刷新后照样在。
   */
  entryNote?: string | null;
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

/** 这条命令最多跑多久。撞到这条线还没完,出路是验收台上那颗「取消」。 */
export const ACCEPT_GATE_TIMEOUT_MS = 90 * 60_000;

/**
 * 日志连着这么久一个字节都不长,就喊一声「这段时间没有任何输出」(落在日志旁边那份进度里,
 * 界面和 agent 看到的回显带着它)。
 *
 * **只报不杀,这是有意的**(第 1 轮审查 F1):日志长不长只能证明「有没有在输出」,
 * 证明不了「有没有在前进」。门禁命令是用户自己填的任意 shell,安静地编译、等远端、
 * 或者干脆 `cmd > its-own.log 2>&1` 把输出重定向到别处 —— 这些都长成「日志不长」的样子,
 * 按静默把它们掐死,是把一套本来能跑完的配置直接判死。反过来也一样:卡死的进程完全
 * 可以一直打心跳,所以「还在输出」也不能拿来断言它在前进。
 *
 * 要提前结束,出路是验收台上那颗「取消」;真想自动掐,得是用户按项目显式配一条,
 * 外加一个比「有没有输出」更硬的进展协议,那是另一件事。
 */
export const ACCEPT_GATE_SILENCE_MS = 20 * 60_000;

/** 多久往门禁日志里落一行进度。这串时间戳就是事后看「它是一直慢还是中途卡住」的依据。 */
export const ACCEPT_GATE_PROGRESS_MS = 5 * 60_000;

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
  // 旧记录可能带着已经撤掉的类别(`command_missing`),查不到标签就照实说「未通过」,
  // 不能让一条历史记录在界面上显示成 undefined。
  const why = (gate.failure
    ? (ACCEPT_GATE_FAILURE_LABELS as Record<string, string | undefined>)[gate.failure] : null) ?? "未通过";
  const rc = gate.exitCode !== null && (gate.failure === "exit_code" || gate.failure === "prepare_failed") ? `（rc=${gate.exitCode}）` : "";
  if (gate.failure === "prepare_failed" && gate.prepareCommand) {
    return `${head} ${ACCEPT_GATE_STATUS_LABELS[gate.status]}：准备命令 \`${gate.prepareCommand}\` 失败${rc}，测试没有开跑`;
  }
  return `${head} ${ACCEPT_GATE_STATUS_LABELS[gate.status]}：${why}${rc}`;
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
  executionNotice?: string | null;
  unavailable?: string | null;
  sourceError?: string | null;
  /** 项目设置里的那条命令;null = 这个项目没设门禁。 */
  command: string | null;
  /** 项目设置里的准备命令(见 Project.acceptGatePrepare);null = 没配。 */
  prepare?: string | null;
  running: AcceptGateView | null;
  /** 最近一次(可能就是 running 那条)。**不是本次验收的凭据**,见 basis。 */
  latest: AcceptGateView | null;
  /**
   * 已经验收过的任务:那一按**实际**拿什么放的行。null = 还没验收,或是没留凭据的老数据
   * (老数据如实显示「没留下凭据」,不拿 latest 冒充)。
   */
  basis: AcceptGateBasis | null;
  /** 项目当前的门禁基准(项目级设置)。 */
  baseline?: AcceptGateBaseline;
  /** 这一档此刻要对照的目标分支;null = 这个任务没有合并目标,三档都按分支快照跑。 */
  baselineTarget?: { branch: string; commit: string } | null;
  /** 按当前这一档,这一按会在门禁之前被拒的理由(没含目标分支 / 预演冲突);null = 不拦。 */
  baselineBlock?: string | null;
  /**
   * 同一件事的结构化那一份,验收台据它摆那一行和它的出路。`handedOffAt` = 这一份预演冲突已经
   * 交给任务的时刻(任务分支头与目标分支头都没动才认);null = 还没交。
   */
  baselineIssue?: {
    reason: "accept_gate_target_behind" | "merge_conflict" | "accept_gate_preview_unavailable";
    targetBranch: string;
    conflictFiles: string[];
    handedOffAt: string | null;
  } | null;
};
