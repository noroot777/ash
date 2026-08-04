// 执行链读这条线时问的那几句话。
//
// `workflow.ts` 那份只管**定义和校验**（它开头就写着「不碰执行」）；执行链要问的是
// 另一类问题：干完之后要不要自动验、没过能重来几轮、验完停不停下等人。把这些问句
// 收在这一个文件里，服务端的审查链和以后别的接管点才不会各自去 steps 数组里刨一遍
// —— 刨法一旦分叉，用户就会看见「线上画着要验、实际没验」。
//
// 这一层**不碰队列、不碰分组**：一条线只描述「这一个任务干完之后怎么走」。人工关口
// 停的是这个任务的验收阶段（stage=awaiting_acceptance），不动 status —— status 是调度
// 用的，动它会顺带停住它所在的队列，那是另一件事。
import type { AcceptClean, AcceptStrategy, WorkflowDef, WorkflowStep } from "./workflow.ts";

export type VerifyStep = Extract<WorkflowStep, { kind: "verify" }>;

/** 老任务（创建于工作流之前，身上没有线）沿用的自动复审上限。 */
export const LEGACY_AUTO_REVIEW_ROUNDS = 2;

export interface WorkflowPolicy {
  /** 「自动验证」那一站；null = 这条线不自动验 */
  verify: VerifyStep | null;
  /**
   * 自动验证最多跑几轮（含头一轮）。只有「没过就拐回去重做」才谈得上第二轮：
   * 「停下等人」「问我一句」都是跑一轮就停。自带起手式写的是 2，跟老常量对齐，
   * 所以从老行为切过来时轮数不会跳变。
   */
  verifyRounds: number;
  /** 没过之后这条线怎么走：停下等人 / 把「怎么办」问到任务上 / 打回给 AI 重做 */
  onVerifyFail: "stop" | "ask" | "back";
  /** 验完停下等人（线上有「等我点头」，且排在验证之后） */
  humanGate: boolean;
  /** 点头之后要合并（线上有「合并并清理」） */
  autoAccept: boolean;
}

// ── 段落切分 ───────────────────────────────────────────────────────────────
// 一条线上的站分两类：**会停下来等**的（干活等 agent、自动验证等审查任务、等我点头
// 等人）和**当场就能做完**的（跑一条命令、打开预览）。执行链只在前者那几个点上被
// 唤醒，所以后者是**成段**跑的：干完之后跑一段、验完之后再跑一段、点头之后再一段。
//
// 这么切而不是记「走到第几站」，是因为不必新开一个「当前站」字段：段落由锚点算得，
// 任务重启、重跑、手动补派审都不会让指针错位。
//
// 代价是**每类锚点在一条线上只能出现一次**：唤醒事件（这一轮结算完、这一轮审查完、
// 用户点了头）只说得清「哪一类锚点过去了」，说不清是第几个，两个 verify 站就没法
// 区分该跑哪一段。所以这不是这里将就一下的事——`checkWorkflow` 直接把重复锚点判成
// 拦下级问题，编辑器的「加一站」里也不给再加第二个。下面按 findIndex 取头一个即可。
export const ANCHOR_KINDS = ["run", "verify", "human"] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

function isAnchor(step: WorkflowStep): boolean {
  return (ANCHOR_KINDS as readonly string[]).includes(step.kind);
}

/** 紧跟在某个锚点之后、到下一个锚点之前的那几站（线上没有这个锚点就是空段）。 */
export function stepsAfterAnchor(
  def: WorkflowDef | null | undefined,
  anchor: AnchorKind,
): WorkflowStep[] {
  if (!def) return [];
  const at = def.steps.findIndex((step) => step.kind === anchor);
  if (at < 0) return [];
  const out: WorkflowStep[] = [];
  for (const step of def.steps.slice(at + 1)) {
    if (isAnchor(step)) break;
    out.push(step);
  }
  return out;
}

export function workflowPolicy(def: WorkflowDef | null | undefined): WorkflowPolicy | null {
  if (!def) return null;
  const steps = def.steps;
  const at = steps.findIndex((step) => step.kind === "verify");
  const verify = at < 0 ? null : (steps[at] as VerifyStep);
  const fail = verify?.fail ?? null;
  return {
    verify,
    verifyRounds: fail?.mode === "back" ? Math.max(1, fail.max) : 1,
    onVerifyFail: fail?.mode ?? "stop",
    // 没有验证站时 at = -1，于是「排在验证之后」退化成「线上有这一站」，正是想要的：
    // 一条 干活 → 等我点头 的线照样停下等人。
    humanGate: steps.some((step, i) => step.kind === "human" && i > at),
    autoAccept: steps.some((step) => step.kind === "accept"),
  };
}

// ── 验收通过时到底做什么 ───────────────────────────────────────────────────
// 「验收通过」这个动作的语义就是**执行线上那一站「合并并清理」**：怎么合（安全合并 /
// squash / 只打标签）、清到什么程度（删 worktree 和分支 / 只删 worktree / 都留着），
// 全读那一站的参数。
//
// 线上**没有**这一站时 merge = null，意思是「这条线不合并」——点验收就只是「我认可
// 这份产物」，git 一动不动，分支和 worktree 都留着。这不是省事：线路图上画着什么，
// 按下去就该发生什么；线上没画合并却偷偷合了，比不合更让人猝不及防（要合就在编排里
// 加上这一站，或者自己合）。
//
// 老任务（身上根本没有线）走 null → 老规矩 safe + all，行为分毫不变。
export interface AcceptPlan {
  /** 怎么合；null = 这条线不合并，只标记验收 */
  merge: AcceptStrategy | null;
  /** 合完清到什么程度 */
  clean: AcceptClean;
}

export const LEGACY_ACCEPT_PLAN: AcceptPlan = { merge: "safe", clean: "all" };

export function acceptPlan(def: WorkflowDef | null | undefined): AcceptPlan {
  if (!def) return LEGACY_ACCEPT_PLAN;
  const step = def.steps.find((s) => s.kind === "accept");
  if (!step || step.kind !== "accept") return { merge: null, clean: "none" };
  return { merge: step.p.strategy, clean: step.p.clean };
}
