// 一轮审查没给出结论时，**它到底是怎么没的**：回合自己中途断了，还是正常收尾了却没上报。
//
// 2026-11-13 现场（任务 EhQtqns9fnG2 第 1 轮）：codex 审查者跑到最后一步，模型上游开始回
// 503（auth_unavailable），重连 5 次后放弃、exit 1，report.md 一个字没写。ash 当时只会说一种话
// ——「报告可能已经写完了，只是结论没能上报；最可能是手上没有 report_stage」——三处全错：报告
// 没写、原因是上游、页面上也没有那颗按钮。那句话的判据从没看过「这一回合是不是自己崩的」，
// 而 single-run 手上明明有退出码、执行故障、看门狗判决。
//
// 「怎么断的」只认**来源确知**的事实：模型 API 的失败由执行器在归一那一层挂上类型
// （`ModelFailure`，executors/model-failure.ts），这里按类型给原因和下一步；不在任意原文里找
// 状态码 —— 一个 400「对话超出长度上限」、或者本机某个 MCP 回的 403，见数就说成「上游连不上，
// 等它恢复」，用户照做只会再失败一次（审查 I2TbHFxtSVAv 第 1 轮第 1 条）。
//
// 这里只做事实整理，不碰落位：分类（`interruptionOf`）是纯函数，读盘（诊断文件、报告文件）
// 各一个小工具，写进轮次那一列的是给页面用的结构（哪一类 + 一句话 + 执行器原话），时间线那句长话由
// review-channel-gap.ts 拼。这份结构出现之前断掉的轮次没存过原因，由 review-no-verdict-legacy.ts
// 按盘上的事实用同一套判法现算。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, ModelFailure } from "@ash/shared";
import type { ReviewNoVerdict } from "@ash/shared/timeline-notice";
import type { RunDiagnostics } from "./executors/diagnostics.js";
import { freeReviewFile } from "./free-review-files.js";
import { RUNS_DIR } from "./paths.js";
import { readableRunPath, runTracePaths } from "./transcript.js";
import type { StallVerdictKind } from "./turn-stall-verdict.js";

/** 这一回合**自己**异常结束的事实（single-run 收尾时手上那几样）。没异常结束就不给。 */
export type TurnFailure = {
  exitStatus: number;
  /**
   * 看门狗 / 执行器判下的那份结论（turn-stall-verdict.ts 的 StallVerdict 里那几样）。熔断判决的
   * `model` 是看门狗按它熔断的**同一批**错误取的（穿过子智能体包装、只认最后那条）。
   */
  verdict: { kind: string; reason: string; model?: ModelFailure | null } | null;
  /** 这一回合执行器报过的那条执行故障（有模型 API 类型的优先，见 single-run）。 */
  error: Pick<Extract<AgentEvent, { kind: "error" }>, "message" | "model"> | null;
};

export type Interruption = {
  /** 页面上那半句：「模型上游连不上（503）」。 */
  reason: string;
  /** 时间线长话里那一段：怎么断的，带状态码和执行器原话。 */
  detail: string;
  /** 下一步：按断的原因说（等上游恢复 / 先修凭据 / 原样续还会撞上…）。 */
  next: string;
  /** 执行器原话截下的那一句（`excerpt`）。什么都没说过就是 null。 */
  quote: string | null;
  /**
   * `reason` 只说得出它是怎么退的（退出码、没带类型的熔断、一条没类型的执行故障），说不出出了
   * 什么错：要知道是什么错只能看原话。
   */
  vague: boolean;
};

/** 执行器原话截一句：第一行、网页正文之前、200 字以内（网关错误页整段贴出来没人看得懂）。 */
function excerpt(raw: string): string {
  let line = raw.trim().split("\n")[0]!.split("<")[0]!;
  // 切在网页之前时，常把一对括号劈在中间（「…(providers=codex; last upstream error:」）：连那个
  // 没合上的括号一起不要。
  const open = line.lastIndexOf("(");
  if (open > 0 && open > line.lastIndexOf(")")) line = line.slice(0, open);
  line = line.replace(/[\s;:,，；：]+$/, "");
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

const RESUME = "点「继续本轮审查」，它会接着上一次的上下文从中断处往下审，不用从头重跑这一轮。";

/** 模型 API 那几类：原因（页面那半句）和下一步。 */
function modelCopy(model: ModelFailure): { reason: string; fact: string; next: string } {
  const code = model.status != null ? `（${model.status}）` : "";
  const fact = model.status != null ? `（状态码 ${model.status}）` : "";
  switch (model.kind) {
    case "unavailable":
      return { reason: `模型上游连不上${code}`, fact: `模型上游连不上${fact}`, next: `等上游恢复后${RESUME}` };
    case "rate_limit":
      return { reason: `模型上游限流${code}`, fact: `模型上游限流${fact}`, next: `等限流过去后${RESUME}` };
    case "quota_exhausted":
      return {
        reason: `模型账户额度用完了${code}`,
        fact: `模型 API 说这个执行器的账户额度、余额或套餐用完了${fact}`,
        next: `等下去不会自己好：先去看这个执行器的模型账户（套餐、额度、账单），处理好之后再${RESUME}`,
      };
    case "auth":
      return { reason: `模型认证失败${code}`, fact: `模型 API 拒绝了这个执行器的凭据${fact}`, next: `先把这个执行器的模型凭据修好，再${RESUME}` };
    case "context_overflow":
      return {
        reason: "对话超出模型长度上限",
        fact: `这一轮的对话超出了模型的长度上限${fact}`,
        next: "原样「继续本轮审查」还会撞上同一个上限：换一个上下文更长的模型，或者「再审一轮」从新会话审起。",
      };
    case "invalid_request":
      return {
        reason: `模型拒收了这次请求${code}`,
        fact: `模型 API 拒收了这次请求${fact}`,
        next: "原样「继续本轮审查」多半还会被拒：先看上面原话里的原因，处理掉再继续，或者「再审一轮」从新会话审起。",
      };
  }
}

// 穷举：加一种判决忘了写措辞就编译不过（tripped 归模型那一支）。
const VERDICT_REASON: Record<Exclude<StallVerdictKind, "tripped">, string> = {
  unverified: "回合结局核实不了",
  background_timeout: "后台工作等到时限还没跑完",
  background_lost: "后台工作没跑完进程就没了",
  background_unverified: "后台工作跑没跑完核实不了",
  wrapup_missing: "后台工作跑完了，智能体没开始整理结果",
};

/**
 * 这一回合是怎么断的。依据按来源确知的程度排：执行器挂了类型的模型 API 失败 > 看门狗熔断时
 * 卡住它的那条错误的类型 > 进程信号 / 其余判决 / 退出码。后几种来源不明，就照实说，带上原话，
 * 不替它归因 —— 熔断判决没带类型也一样：类型缺了不等于「上游连不上、等等就好」，那可能是额度、
 * 也可能根本没有错误（静默档），叫人干等就是替它编了一个会自己恢复的原因（第 3 轮审查第 1 条）。
 */
export function interruptionOf(failure: TurnFailure, diagnostics: Pick<RunDiagnostics, "failureReason" | "exitSignal"> | null): Interruption {
  // 原话只认执行器自己说的（它报的错、诊断里记的那段）。判决的原文是 ash 自己的话（看门狗的熔断
  // 诊断、核实不了的说明）：执行器一句都没说过的时候它照样进说明，但标明是谁说的，不进 `quote`。
  const raw = failure.error?.message?.trim() || diagnostics?.failureReason?.trim() || "";
  const quote = raw ? excerpt(raw) : null;
  const judged = failure.verdict?.reason?.trim();
  const said = quote ? `执行器的原话：「${quote}」` : judged ? `ash 的判断：「${excerpt(judged)}」` : "";
  const exit = failure.exitStatus !== 0 ? `执行器以 exit ${failure.exitStatus} 结束` : "";
  const model: ModelFailure | null = failure.error?.model ?? (failure.verdict?.kind === "tripped" ? failure.verdict.model ?? null : null);
  if (model) {
    const copy = modelCopy(model);
    return { reason: copy.reason, detail: [copy.fact, exit, said].filter(Boolean).join("，"), next: copy.next, quote, vague: false };
  }
  if (failure.verdict?.kind === "tripped") {
    const reason = "回合长时间没有进展，被自动终止";
    return {
      reason, detail: [reason, exit, said].filter(Boolean).join("，"), next: `先看上面的${quote ? "原话" : "判断"}弄清卡在哪里，处理好之后再${RESUME}`,
      quote, vague: true,
    };
  }
  const signal = diagnostics?.exitSignal;
  const known = signal ? `执行器进程被 ${signal} 结束` : failure.verdict && (VERDICT_REASON as Record<string, string>)[failure.verdict.kind];
  const reason = known || (failure.exitStatus !== 0 ? `执行器异常退出（exit ${failure.exitStatus}）` : "执行器报了执行故障");
  return { reason, detail: [reason, said].filter(Boolean).join("，"), next: RESUME, quote, vague: !known };
}

/** codex 落的那一份诊断（executors/diagnostics.ts）。别的执行器没有，读不出来就当没有。 */
export function readTurnDiagnostics(taskId: string, sessId: string, turnStart: string): RunDiagnostics | null {
  const path = readableRunPath(runTracePaths(join(RUNS_DIR, taskId), sessId, turnStart).diagnosticsPath);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunDiagnostics>;
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return null;
    // 这份文件只是佐证：用到的两格类型不对就当那一格没有，别让一份坏诊断把回合收尾打断。
    return {
      ...parsed,
      failureReason: typeof parsed.failureReason === "string" ? parsed.failureReason : null,
      exitSignal: typeof parsed.exitSignal === "string" ? parsed.exitSignal : null,
    } as RunDiagnostics;
  } catch {
    return null;
  }
}

/**
 * 这一轮的报告真写出来了吗：跟页面读报告**同一个入口**（`freeReviewFile`：普通文件、不是链接、
 * 没有越出证据目录）。各认各的就会出现「这里说写好了、页面却说报告尚未生成」。空文件不算。
 */
export function reviewReportWritten(taskId: string, runId: string, round: number): boolean {
  try {
    const file = freeReviewFile(taskId, runId, round, "report.md");
    return !!file && readFileSync(file, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

/** 页面上那一份：哪一类 + 一句话（+ 执行器原话、原因是不是笼统）。 */
export function noVerdictCause(interruption: Interruption | null, reportWritten: boolean): ReviewNoVerdict {
  if (interruption) {
    return {
      kind: "interrupted", reason: interruption.reason,
      ...(interruption.quote ? { said: interruption.quote } : {}),
      ...(interruption.vague ? { vague: true as const } : {}),
    };
  }
  return { kind: "unreported", reason: reportWritten ? "报告写完了，结论没报上来" : "回合收尾了，结论没报上来" };
}
