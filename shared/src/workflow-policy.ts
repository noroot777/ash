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
import type { WorkflowDef, WorkflowStep } from "./workflow.js";

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
  /** 没过之后这条线怎么走（"ask" 目前按 "stop" 执行，只是措辞不同） */
  onVerifyFail: "stop" | "ask" | "back";
  /** 验完停下等人（线上有「等我点头」，且排在验证之后） */
  humanGate: boolean;
  /** 点头之后要合并（线上有「合并并清理」） */
  autoAccept: boolean;
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
