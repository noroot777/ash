// 一轮审查没给出结论时，**它到底是怎么没的**：回合自己中途断了，还是正常收尾了却没上报。
//
// 2026-11-13 现场（任务 EhQtqns9fnG2 第 1 轮）：codex 审查者跑到最后一步，模型上游开始回
// 503（auth_unavailable），重连 5 次后放弃、exit 1，report.md 一个字没写。ash 当时只会说一种话
// ——「报告可能已经写完了，只是结论没能上报；最可能是手上没有 report_stage」——三处全错：报告
// 没写、原因是上游、页面上也没有那颗按钮。那句话的判据从没看过「这一回合是不是自己崩的」，
// 而 single-run 手上明明有退出码、执行故障、看门狗判决，codex 还落了一份诊断文件。
//
// 这里只做事实整理，不碰落位：分类（`interruptionOf`）是纯函数，读盘（诊断文件、报告文件）
// 各一个小工具，写进轮次那一列的是给页面用的结构（哪一类 + 一句话），时间线那句长话由
// review-channel-gap.ts 拼。
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ReviewNoVerdict } from "@ash/shared/timeline-notice";
import type { RunDiagnostics } from "./executors/diagnostics.js";
import { freeReviewReportPath } from "./free-review-files.js";
import { RUNS_DIR } from "./paths.js";
import { runTracePaths } from "./transcript.js";
import type { StallVerdictKind } from "./turn-stall-verdict.js";

/** 这一回合**自己**异常结束的事实（single-run 收尾时手上那几样）。没异常结束就不给。 */
export type TurnFailure = {
  exitStatus: number;
  /** 看门狗 / 执行器判下的那份结论（turn-stall-verdict.ts 的 StallVerdict 里那两样）。 */
  verdict: { kind: string; reason: string } | null;
  /** 这一回合执行器报过的最后一条执行故障（error 事件原文）。 */
  lastError: string | null;
};

export type Interruption = {
  /** 页面上那半句：「模型上游连不上（503）」。 */
  reason: string;
  /** 时间线长话里那一段：怎么断的，带状态码和执行器原话。 */
  detail: string;
  /** 上游类的：下一步要先等上游恢复。 */
  upstream: boolean;
};

/**
 * 原文里的 HTTP 状态码。只认**紧跟在「status / API Error / HTTP」后面**的那个数：同一段原文里
 * 常夹着网关错误页（现场那份里就有一句「Error reference number: 504」），见数就取会报错码。
 */
const STATUS_PATTERNS = [
  /(?:^|[^a-z])status(?:[ _]?code)?["']?\s*[:=]?\s*(\d{3})\b/i,
  /\bAPI Error:?\s*(\d{3})\b/i,
  /\bHTTP(?:\/[\d.]+)?\s+(\d{3})\b/i,
];

export function upstreamStatus(texts: readonly string[]): number | null {
  for (const text of texts) for (const pattern of STATUS_PATTERNS) {
    const code = Number(pattern.exec(text)?.[1]);
    if (code >= 400 && code <= 599) return code;
  }
  return null;
}

/** 没有状态码、但说的是「连不上模型」的那几种（断流、重连、网络层错误、过载）。 */
const UPSTREAM_WORDS = /stream disconnected|reconnecting|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|connection (?:lost|reset|refused|closed)|overloaded|rate.?limit|service unavailable|bad gateway|gateway time-?out|upstream/i;

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

// 穷举：加一种判决忘了写措辞就编译不过（tripped 归上游那一支）。
const VERDICT_REASON: Record<Exclude<StallVerdictKind, "tripped">, string> = {
  unverified: "回合结局核实不了",
  background_timeout: "后台工作等到时限还没跑完",
  background_lost: "后台工作没跑完进程就没了",
  background_unverified: "后台工作跑没跑完核实不了",
  wrapup_missing: "后台工作跑完了，智能体没开始整理结果",
};

/**
 * 这一回合是怎么断的。依据按可信程度排：执行器自己的诊断文件（codex）> 回合里报的执行故障
 * > 看门狗判决原文。上游类的只要任一份里有状态码、或者看门狗判了熔断（`tripped` = 整段时间
 * 只收到重试类错误），就按上游说。
 */
export function interruptionOf(failure: TurnFailure, diagnostics: Pick<RunDiagnostics, "failureReason" | "exitSignal"> | null): Interruption {
  const texts = [diagnostics?.failureReason, failure.lastError, failure.verdict?.reason]
    .filter((text): text is string => !!text?.trim());
  const code = upstreamStatus(texts);
  const upstream = code != null || failure.verdict?.kind === "tripped" || texts.some((text) => UPSTREAM_WORDS.test(text));
  const said = texts[0] ? `执行器的原话：「${excerpt(texts[0])}」` : "";
  const exit = failure.exitStatus !== 0 ? `执行器以 exit ${failure.exitStatus} 结束` : "";
  if (upstream) {
    const reason = code === 429 ? "模型上游限流（429）"
      : code === 401 || code === 403 ? `模型上游拒绝了认证（${code}）`
        : `模型上游连不上${code ? `（${code}）` : ""}`;
    const facts = [`${reason.replace(/（\d+）$/, "")}${code ? `（状态码 ${code}）` : ""}`, exit, said].filter(Boolean);
    return { reason, detail: facts.join("，"), upstream: true };
  }
  const signal = diagnostics?.exitSignal;
  const reason = signal ? `执行器进程被 ${signal} 结束`
    : (failure.verdict && (VERDICT_REASON as Record<string, string>)[failure.verdict.kind])
      || (failure.exitStatus !== 0 ? `执行器异常退出（exit ${failure.exitStatus}）` : "执行器报了执行故障");
  return { reason, detail: [reason, said].filter(Boolean).join("，"), upstream: false };
}

/** codex 落的那一份诊断（executors/diagnostics.ts）。别的执行器没有，读不出来就当没有。 */
export function readTurnDiagnostics(taskId: string, sessId: string, turnStart: string): RunDiagnostics | null {
  const path = runTracePaths(join(RUNS_DIR, taskId), sessId, turnStart).diagnosticsPath;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunDiagnostics>;
    return parsed && typeof parsed === "object" && parsed.version === 1 ? parsed as RunDiagnostics : null;
  } catch {
    return null;
  }
}

/** 这一轮的报告真写出来了吗：看文件，不猜。空文件不算。 */
export function reviewReportWritten(taskId: string, runId: string, round: number): boolean {
  const path = freeReviewReportPath(taskId, runId, round);
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

/** 页面上那一份：哪一类 + 一句话。 */
export function noVerdictCause(interruption: Interruption | null, reportWritten: boolean): ReviewNoVerdict {
  if (interruption) return { kind: "interrupted", reason: interruption.reason };
  return { kind: "unreported", reason: reportWritten ? "报告写完了，结论没报上来" : "回合收尾了，结论没报上来" };
}
