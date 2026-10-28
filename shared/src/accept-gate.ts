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
/**
 * 起跑前核到「这条命令点名的东西不在这份快照里」之后,**这件事看起来是不是这次改动造成的**。
 *
 * 只有两档,而且**两档都不免修**(第 10 轮审查 F2):
 *  - `mine`    起跑前核的那份定义,开工基线上有、这份快照里没了 → 线索指向这次改动,去核、去改;
 *  - `unknown` 其余全部(基线上也没有、目标 ref 读不到、非 git 快照、超预算…)→ 先核归因。
 *
 * **没有 not-mine 这一档**:它曾经用来授权「不要为这件事改任何代码」,而授权它的是**静态读**
 * 出来的那份定义 —— 两次静态读到同一个对象,证明不了 runner 真去找的就是那一份(PATH 上的
 * 同名包装器、`.npmrc`、workspace 配置都能把落点挪走)。证明不了就不许免修,所以这一档整个
 * 撤掉了:存在性只当线索,责任保留为未知。经过见 server/src/accept-gate-miss.ts 的文件头。
 */
export type AcceptGateMissAttribution = "mine" | "unknown";

/**
 * 没通过时具体是哪一种没通过。
 *
 * **没有「命令不存在」这一档**(第 10 轮审查 F1):真跑那一次有没有启动,得有能绑到这次执行
 * 身份上的证据才敢说,而起跑前的纯读 + 日志形状都给不出来。命令解析不出来仍然会得到一段
 * 结论(`diagnosis`),但失败类别照实留在它真实的那一档上(多半是 `exit_code`)。
 * 旧记录里可能还存着 `command_missing`,读的那几处都做了兜底。
 */
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

/**
 * 归类结论(`diagnosis` / `missAttribution`)是**哪一代判据**生成的。
 *
 * 为什么要这个东西(第 2 轮审查 F1):第 10 轮撤回了「这条命令一行都没跑到、不要为它改代码」
 * 那个结论,可**撤回只管得住生成侧** —— 撤回之前已经落盘的那些结论,刷新页面、再交一次给
 * agent、跨机迁入时照旧原样端出来,一句已经被证伪的话继续当今天的事实用。
 *
 * 所以结论落盘时把代号一起记下,读侧只认当代那一份:代号不匹配(含旧行的 null)一律**不承担
 * 当前结论**,原文只作为历史放进 `legacyDiagnosis`,界面上带失效说明给人查证。
 *
 * **改了结论的授权判据,就要把这个代号往前挪** —— 它是让旧结论自动失效的唯一机关。
 */
export const ACCEPT_GATE_DIAGNOSIS_GENERATION = "2026-10-27-clue";

/**
 * 把存下来的 failure 归一到**当前**的联合里。认不出的(撤掉的 `command_missing`、将来再撤的
 * 任何一档)一律 null = 「未通过,没有具体分类」 —— 旧类别本身就是旧判据下的结论,不能靠
 * 字段还在就继续当事实(第 2 轮审查 F1)。exit_code / timeout 这些是真实观测,照旧保留。
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
   * 这一次红了之后的**归类结论**:为什么它不是「代码红了」、目标分支上是什么情形、
   * 出路有哪几条。null = 没有可归类的结论(普通的测试红、或认不出)。
   *
   * 必须落盘而不是现算:用户看到这张卡可能已经是几小时后、刷新过好几次,而那几条 git
   * 事实(目标分支当时是哪个提交)此后还会变 —— 现算出来的话,结论会跟着漂。
   */
  diagnosis?: string | null;
  /**
   * **旧代号那一版**生成的结论原文(见 ACCEPT_GATE_DIAGNOSIS_GENERATION)。
   *
   * 非空就等于「这一次名下存着一段已经失效的结论」:它不是当前事实,不进交给 agent 的正式
   * 输入,界面上只能带失效说明摆出来给人查证 —— 原文和日志都保留,但一个字都不许再承担
   * 当前诊断或指导执行的作用(第 2 轮审查 F1)。
   */
  legacyDiagnosis?: string | null;
  /**
   * 见 AcceptGateMissAttribution。**非空就等于「起跑前核到那个名字不在这份快照里」**
   * （归类落在 entry 那一档才会写它），卡片和交接拿它当这件事的信号。
   */
  missAttribution?: AcceptGateMissAttribution | null;
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
  executionNotice?: string | null;
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
