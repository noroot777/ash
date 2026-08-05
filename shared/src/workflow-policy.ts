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
  /** 点头之后要合并（线上有「合并并清理」） */
  autoAccept: boolean;
}

// ── 段落切分 ───────────────────────────────────────────────────────────────
// 一条线上的站分两类：**会停下来等**的（干活等 agent、自动验证等审查任务、等我点头
// 等人）和**当场就能做完**的（跑一条命令、打开预览）。执行链只在前者那几个点上被
// 唤醒，所以后者是**成段**跑的：干完之后跑一段、验完之后再跑一段、点头之后再一段。
//
// 段落按**站的 id** 切，不按「哪一类锚点」——任务身上记着一个游标（`tasks.workflow_at`
// = 这条线此刻停在哪一站），唤醒事件落回来时就知道是**第几个**验证站有了结论、用户
// 在**哪一道**关口点了头。这正是「自动验证」「等我点头」能在一条线上出现多次的前提：
// 早先按锚点类型切段时，第二个 verify 站没有任何东西能把它跟第一个区分开，只会被
// 静默跳过（所以那时它们被列进 SINGLETON_KINDS）。
//
// 游标丢了（老任务、手动补派审、快照被换过）也不会卡死：调用方一律用 firstAnchor()
// 回落到线上第一个同类锚点，退化成原来的行为。
export const ANCHOR_KINDS = ["run", "verify", "human"] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export function isAnchorKind(kind: WorkflowStep["kind"]): kind is AnchorKind {
  return (ANCHOR_KINDS as readonly string[]).includes(kind);
}

function isAnchor(step: WorkflowStep): boolean {
  return isAnchorKind(step.kind);
}

/** 线上第一个某类锚点站；游标丢失时的回落点。 */
export function firstAnchor(
  def: WorkflowDef | null | undefined,
  kind: AnchorKind,
): WorkflowStep | null {
  return def?.steps.find((step) => step.kind === kind) ?? null;
}

/** 紧跟在**某一站**之后、到下一个锚点之前的那几站（找不到这一站就是空段）。 */
export function segmentAfter(
  def: WorkflowDef | null | undefined,
  stepId: string | null | undefined,
): WorkflowStep[] {
  if (!def || !stepId) return [];
  const at = def.steps.findIndex((step) => step.id === stepId);
  if (at < 0) return [];
  const out: WorkflowStep[] = [];
  for (const step of def.steps.slice(at + 1)) {
    if (isAnchor(step)) break;
    out.push(step);
  }
  return out;
}

/** 某一站之后的第一个锚点站；null = 这条线走到头了。 */
export function nextAnchor(
  def: WorkflowDef | null | undefined,
  stepId: string | null | undefined,
): WorkflowStep | null {
  if (!def || !stepId) return null;
  const at = def.steps.findIndex((step) => step.id === stepId);
  if (at < 0) return null;
  return def.steps.slice(at + 1).find(isAnchor) ?? null;
}

/**
 * 某一站**之前**的最后一个锚点站；null = 它前面没有锚点了。
 *
 * 用在一个地方：某一站没过、打回给 AI 重做时，游标要退回到它前面那个锚点——这样
 * 重做完再结算，紧跟在那个锚点后面的那一段（典型：先 build 再验）会照样重跑一遍，
 * 然后**重新验这一站**，而不是把它当验过了往下走。
 */
export function prevAnchor(
  def: WorkflowDef | null | undefined,
  stepId: string | null | undefined,
): WorkflowStep | null {
  if (!def || !stepId) return null;
  const at = def.steps.findIndex((step) => step.id === stepId);
  if (at < 0) return null;
  return def.steps.slice(0, at).filter(isAnchor).at(-1) ?? null;
}

/** 老口径：紧跟线上头一个某类锚点之后的那一段（run 仍然唯一，它照旧够用）。 */
export function stepsAfterAnchor(
  def: WorkflowDef | null | undefined,
  anchor: AnchorKind,
): WorkflowStep[] {
  return segmentAfter(def, firstAnchor(def, anchor)?.id);
}

/**
 * 这一道人工关口是不是**最后一道**（后面再没有「等我点头」了）。
 *
 * 「验收通过」这一按在最后一道关口上才等于「这份产物我认了，去合吧」；中途那几道是
 * 放行，点完只往下走一段，绝不能顺手把不可逆的合并做掉。游标丢了当最后一道处理——
 * 那正是只有一道关口的老行为。
 */
export function isFinalHumanGate(
  def: WorkflowDef | null | undefined,
  at: string | null | undefined,
): boolean {
  if (!def || !at) return true;
  const idx = def.steps.findIndex((step) => step.id === at);
  if (idx < 0 || def.steps[idx]!.kind !== "human") return true;
  return !def.steps.slice(idx + 1).some((step) => step.kind === "human");
}

/**
 * 这条线此刻停在哪一站。游标为空或指到不存在的站时回落到线上第一个该类锚点，
 * 于是老任务、换过快照的任务、手动补派审都还是原来的行为。
 */
export function anchorAt(
  def: WorkflowDef | null | undefined,
  at: string | null | undefined,
  kind: AnchorKind,
): WorkflowStep | null {
  const step = at ? def?.steps.find((s) => s.id === at) ?? null : null;
  return step?.kind === kind ? step : firstAnchor(def, kind);
}

export function workflowPolicy(
  def: WorkflowDef | null | undefined,
  // 当前停在哪一站；多个「自动验证」时轮数与失败策略都读**这一站**的。
  at?: string | null,
): WorkflowPolicy | null {
  if (!def) return null;
  const steps = def.steps;
  const verify = anchorAt(def, at, "verify") as VerifyStep | null;
  const fail = verify?.fail ?? null;
  // 这里**不再有 humanGate**。它曾经的判据是「有 human 站且排在 verify 之后」——那是
  // 「按锚点类型读线」时代的遗物，用户把「等我点头」画在「自动验证」前面时，整条线会
  // 被判成「没写等我点头」，一路自动验证 + 自动合并（2026-08-05 事故，见
  // docs/incidents.md「关口画在验证前面就被跳过」）。停不停下等人是**推进器按游标**
  // 逐站走出来的结论，不是这里能一次算出的属性；再想在这儿加一个同类问句之前，先问
  // 一句「它是不是又在假设某种站的顺序」。
  return {
    verify,
    verifyRounds: fail?.mode === "back" ? Math.max(1, fail.max) : 1,
    onVerifyFail: fail?.mode ?? "stop",
    autoAccept: steps.some((step) => step.kind === "accept"),
  };
}

// ── 验收通过时到底做什么 ───────────────────────────────────────────────────
// 「验收通过」这个动作的语义就是**执行线上那一站「合并并清理」**：怎么合（安全合并 /
// squash / 只打标签）、清到什么程度（删 worktree 和分支 / 只删 worktree / 都留着），
// 全读那一站的参数。
//
// 线上**没有**这一站时，做什么取决于**谁按下的**——同一个「验收通过」，线自己走到
// 和人亲手点，不是一件事：
//
// - 线自己走到（`by: "workflow"`）→ merge = null，git 一动不动。线路图上画着什么，
//   跑起来就只该发生什么；没画合并却自动合了，比不合更让人猝不及防。
// - **人亲手点**（`by: "human"`，默认）→ 老规矩 safe + all，覆盖线上写没写。人不会被
//   自己按的按钮吓到，「猝不及防」这条理由在这条路上不成立；而一个叫「验收通过」的
//   按钮如果只记一笔「我认可」，它实际上就是个点赞按钮——用户点完还得自己去 git 里
//   合一遍，编排配置从「描述流程」变成了「拦着人」。手按的这一下是最高指令。
//   不可逆的部分由按下之前的确认框兜：前端 `acceptanceMessage` 照实说清这一按会发生
//   什么，包括「线上没画这一站，但手动验收仍会合」。
//
// 老任务（身上根本没有线）走 null → 老规矩 safe + all，两条路都一样，行为分毫不变。
//
// **唯一一个「手按也不合」的例外是中途人工关口**（线上写了不止一道「等我点头」，而这
// 一按发生在前面某一道上）：那时「验收通过」的意思是「这一关我放行」，后面还画着别的
// 站呢，顺手把不可逆的合并做掉是拿用户没表达过的意思替他做主。判定在 isFinalHumanGate。
//
// 推论：以后再加**自动**触发验收的路径，必须显式传 `"workflow"`；默认值是给人用的。
export interface AcceptPlan {
  /** 怎么合；null = 这条线不合并，只标记验收 */
  merge: AcceptStrategy | null;
  /** 合完清到什么程度 */
  clean: AcceptClean;
}

export const LEGACY_ACCEPT_PLAN: AcceptPlan = { merge: "safe", clean: "all" };

/** 这次验收是谁按下的。默认是人——自动路径必须自己显式说明。 */
export type AcceptBy = "human" | "workflow";

/** 线上有没有画「合并并清理」这一站（人工验收会覆盖它，但文案要照实说）。 */
export function hasAcceptStation(def: WorkflowDef | null | undefined): boolean {
  return !!def && def.steps.some((s) => s.kind === "accept");
}

export function acceptPlan(
  def: WorkflowDef | null | undefined,
  by: AcceptBy = "human",
  // 这一按发生在哪一道人工关口上（`tasks.workflow_at`）。中途关口不合并——理由见
  // isFinalHumanGate。省略 = 老行为（只有一道关口）。
  at?: string | null,
): AcceptPlan {
  if (!def) return LEGACY_ACCEPT_PLAN;
  if (!isFinalHumanGate(def, at)) return { merge: null, clean: "none" };
  const step = def.steps.find((s) => s.kind === "accept");
  if (!step || step.kind !== "accept") {
    return by === "human" ? LEGACY_ACCEPT_PLAN : { merge: null, clean: "none" };
  }
  return { merge: step.p.strategy, clean: step.p.clean };
}
