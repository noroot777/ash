// 两档动手时**说给用户的那些话** —— 全部措辞只此一份。
//
// 为什么从 `turn-stall.ts` 拆出来:那个文件装的是判据状态机(什么算「上游真回话了」、两档各自
// 什么时候触发),写到 690 行已经贴着单文件上限(根 CLAUDE.md 700 行)。而措辞自成一件事 ——
// 它只读 `StallFacts` / `StallVerdict` 这两份事实,一个字都不碰 `stalls` 表、定时器和阈值,
// 所以搬出来不需要把任何状态跟着导出。
//
// **这里是措辞的唯一产地**:同一个结论在实时提示、时间线、`.md`、启动对账四处出现,各处自己
// 拼一遍就会漂成四个版本(而用户看到的是其中任意一个)。四处都来这儿取。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { detachedPathsFor } from "./executors/detached-child.js";
import { RUNS_DIR } from "./paths.js";
import { runTracePaths } from "./transcript.js";
import type { StallVerdict } from "./turn-stall-verdict.js";
import type { StallFacts } from "./turn-stall.js";

const minutes = (ms: number): string => {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  return `${Math.round(ms / 60_000)} 分钟`;
};

/** 错误条数 + 其中多少条是重试提示 + 多少条来自子智能体线程。措辞不该把三种混成一种。 */
const tally = (facts: StallFacts): string => {
  const head = facts.retries >= facts.errors
    ? `共 ${facts.errors} 条,全部是上游重试提示`
    : `共 ${facts.errors} 条,其中 ${facts.retries} 条是上游重试提示`;
  if (!facts.childErrors) return head;
  return `${head};${facts.childErrors === facts.errors ? "全部" : `其中 ${facts.childErrors} 条`}来自子智能体线程`;
};

const lastLine = (facts: StallFacts): string =>
  facts.lastMessage ? `最后一条:${facts.lastMessage}` : "最后一条错误没有附带说明。";

/** 卡在哪一步 —— 「工具跑完等模型总结」和「一条正常输出都没有过」是两种现场。 */
const stalledAfter = (facts: StallFacts): string =>
  facts.lastProgressKind
    ? `停滞前这一轮最后一条正常事件是 ${facts.lastProgressKind}。`
    : "这一轮从头到尾没有过任何正常事件(连接多半压根没建起来)。";

/**
 * 原始事件流的**落点**。
 *
 * 给目录是不够的 —— 一个任务目录下几十个文件,出事那一轮是哪一个得人去猜(第 1 轮审查
 * 非拦项)。两组文件名都是 `(sessionId, 回合起点)` 的纯函数(`detachedPathsFor` /
 * `runTracePaths`),所以这里能算出确切路径;`existsSync` 过一遍只报真的存在的那几个,
 * 免得指一个不存在的文件给用户。都不存在就退回目录。
 */
function rawLogHint(facts: StallFacts): string {
  const dir = join(RUNS_DIR, facts.taskId);
  const candidates = [
    detachedPathsFor(dir, facts.sessionId, facts.turnStartedAt).out,
    runTracePaths(dir, facts.sessionId, facts.turnStartedAt).eventsPath,
  ];
  const found = candidates.filter((path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  });
  return found.length ? found.join("；") : `${dir}(本回合未单独落原始事件流)`;
}

/** 警告档的文案。落进执行过程里它发生的那个位置,所以写成「此刻怎么了」。 */
export function stallWarningText(facts: StallFacts): string {
  return `〔上游停滞〕自上一条正常输出以来只收到错误事件(${tally(facts)}),已经 ${minutes(facts.elapsedMs)}`
    + `没有任何模型输出或工具调用 —— 多半是模型上游连不上。${lastLine(facts)}`;
}

/** 熔断档的文案:完整诊断(重试次数、停滞起点、原始日志落点、怎么续)+ 阈值怎么调。 */
export function stallTripText(facts: StallFacts): string {
  return `〔上游停滞·已自动终止本回合〕自 ${facts.since} 起连续 ${minutes(facts.elapsedMs)}`
    + `只收到错误事件、没有任何模型输出或工具调用(${tally(facts)}),判定模型上游连不上,`
    + `已终止本回合并按失败结算。${stalledAfter(facts)}${lastLine(facts)}\n`
    + `原始事件流:${rawLogHint(facts)}(会话 ${facts.sessionId},回合起于 ${facts.turnStartedAt})\n`
    + "可直接重试续跑,或换一个执行器/供应商再跑。"
    + "熔断时长由 ASH_STALL_TRIP_MS 配置(默认 30 分钟,置 0 关闭);"
    + "警告档是 ASH_STALL_WARN_ERRORS(默认 5 条)与 ASH_STALL_WARN_MS(默认 5 分钟)。";
}

/**
 * **一份上一次运行留下的判决,要怎么对用户讲** —— 共同那一句加判决原文,由这一处出。
 *
 * 为什么不许各处自己措辞(第 2 轮续聊自审):这条链上反复出事的形状就是**同一个结论在两处被
 * 说成两件事**(「已自动终止」的红字 vs 落位说的「它在等你」)。接管那一路和启动对账那一路说的
 * 是同一件事,只有收场不同,所以共同那一句和判决原文的格式必须只有一份。
 *
 * 判决原文整段带上 —— 上一次运行写的那条诊断可能随进程一起没了(trace 那一笔同样可能排在
 * 队里),这里是用户唯一还能看到它的地方。
 */
function carriedVerdictText(verdict: StallVerdict, tail: string): string {
  return "这一回合在上次 ash 运行期间已被判定上游连不上并按失败结算,"
    + `${tail}原判决(${verdict.at}):${verdict.reason}`;
}

/** 「这台 ash 为什么核不了自己的判决」—— 同理,只有一份。 */
function unverifiableText(why: string, tail: string): string {
  return "这一回合是上次 ash 中断时留下的,而本次启动读不出熔断判决日志"
    + `(${why}),无法确认它当时有没有被判定上游连不上并按失败结算。${tail}`;
}

/** 接管那一路:进程还在,义务没兑现完 —— **如实说这是上一次运行的判决**,别冒充这一刻才判的。 */
export function stallResumeText(verdict: StallVerdict): string {
  return "〔上游停滞·接管后继续终止〕"
    + carriedVerdictText(verdict, "重启接管后仍背着尚未兑现的终止义务,现在把它终止。");
}

/** 启动对账那一路:原进程已经不在了,没有什么可终止的,只有收口。 */
export function stallReconcileText(verdict: StallVerdict): string {
  return "〔上游停滞·重启后按失败收尾〕"
    + carriedVerdictText(verdict, "服务重启后原进程已不在,这一轮按失败收尾。");
}

/** 启动对账那一路的「核实不了」版本。 */
export function stallReconcileUnverifiableText(why: string): string {
  return "〔上游停滞·上一次运行的结局核实不了〕"
    + unverifiableText(why, "原进程也已经不在 —— 这一轮按未完成收尾,不记成完成:"
      + "可能它本来就是失败的,也可能日志故障让我们冤枉了它,两种都不该悄悄记成完成。"
      + "先把日志那个故障修掉(多半是权限或磁盘)。");
}

/** 消费那一路的「核实不了」版本:进程还活着,所以这一轮会跑完,只是不许按成功结算。 */
export function stallUnverifiableText(why: string): string {
  return "〔上游停滞·上一次运行的结局核实不了〕"
    + unverifiableText(why, "这一轮因此**不会**按成功结算 —— 可能它本来就是失败的,也可能日志"
      + "故障让我们冤枉了它,两种都不该悄悄记成完成。续跑材料一个字没动:确认过工作成果之后点"
      + "重试或者直接续聊即可;先把日志那个故障修掉(多半是权限或磁盘),下一轮就不会再遇到这一句。");
}

/**
 * 判决**没能存住**时补在熔断诊断后面的一句。
 *
 * 为什么要说出来:这一轮照常被终止、照常按失败结算,但那个结论只在当前进程的内存里 —— 如果
 * ash 在这一轮结算完之前重启,接管的新进程读不到它,这一轮可能又显示成「已完成」。这正是
 * F1 那条路,出现过一次就不该再让用户自己去猜。
 */
export function stallVolatileVerdictText(): string {
  return "注意:这个结论没能写进磁盘(多半是磁盘满或权限问题),"
    + "如果 ash 在本回合结算完之前重启,它可能重新显示成已完成 —— 以这条诊断为准。";
}

/** 兜底档的文案:终止请求没生效,这一轮是被**回收句柄**结束的 —— 如实说,别冒充前一句。 */
export function stallEscalateText(facts: StallFacts, graceMs: number): string {
  return `〔上游停滞·终止请求未生效,已回收进程〕${minutes(graceMs)}前已请求终止这一停滞回合,`
    + `到现在仍未收到回合结束 —— 改为直接回收它的进程。这一轮仍按失败结算(${tally(facts)})。\n`
    + "宽限期由 ASH_STALL_TRIP_GRACE_MS 配置(默认 60 秒,置 0 关闭这一档)。";
}
