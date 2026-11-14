import type { AcceptanceSteps } from "@ash/shared/accept-message";

/**
 * 确认层「这一按会做什么」的推导。纯函数：画法在 AcceptConfirm.tsx，这里只管
 * 「勾成这样 → 一步一行写什么、确认键叫什么、能不能按、发给后端的参数是什么」。
 *
 * 两个勾都只活在这一层里：关掉就回到默认（留着上次的选择，等于一个没人记得设过的隐形开关）。
 *  - 「运行」：已有一次还作数的绿时默认不勾（沿用那次），勾上 = 重跑；否则默认勾着，取消 = 这次跳过。
 *  - 「提交」：默认跟项目设置。发给后端的是**这一层里看到的那个值**，不让后端再读一次项目设置。
 */
export type ConfirmGate = {
  command: string;
  /** 有一次还作数的绿：这一按会沿用它，不重跑。 */
  reusable: boolean;
  /** 「多久前通过」（reusable 时）。 */
  passedAgo: string | null;
  /** 上一次没过：跳过时那一行要标出来。 */
  lastFailed: boolean;
  /** 基准先挡住了（冲突、没含最新目标、预览做不出来）：勾着运行，这一按会被拒在门禁之前。 */
  issue: string | null;
};

export type ConfirmInput = {
  steps: AcceptanceSteps;
  /** null = 这一按不碰前置命令（没设、只是放行、团队联动之外的那几种）。 */
  gate: ConfirmGate | null;
  /** 「运行」那一勾；null = 没动过。 */
  runChoice: boolean | null;
  /** 能不能选「提交」（会真合并的那几档）。 */
  commitChoosable: boolean;
  /** 「提交」那一勾；null = 没动过，跟项目默认。 */
  commitChoice: boolean | null;
  /** 项目默认；null = 还没读到（读到之前一律不许确认）。 */
  commitDefault: boolean | null;
  /** 一次验收几个任务（父任务 + 勾上的派生任务）；1 = 只验这一个。 */
  count: number;
  /** 独立验证尚未执行：要先勾「知情」。 */
  verification: "none" | "loading" | "error" | "unacknowledged" | "acknowledged";
};

export type ConfirmView = {
  runs: boolean;
  commit: boolean;
  /** 一次多个任务又不提交：只能合一个。 */
  batchNeedsCommit: boolean;
  confirmLabel: string;
  confirmDisabled: boolean;
  /** 发给 /accept 的那两个参数。 */
  gateIntent: "skip" | "rerun" | undefined;
  commitParam: boolean | undefined;
};

export function confirmView(input: ConfirmInput): ConfirmView {
  const { steps, gate } = input;
  const runs = gate ? input.runChoice ?? !gate.reusable : false;
  const gateIntent = !gate ? undefined : gate.reusable ? (runs ? "rerun" : undefined) : runs ? undefined : "skip";
  const commitKnown = input.commitChoice !== null || input.commitDefault !== null;
  const commit = input.commitChoosable ? input.commitChoice ?? input.commitDefault ?? true : true;
  const batchNeedsCommit = input.commitChoosable && !commit && input.count > 1;
  const confirmLabel = steps.kind === "release" ? "放行"
    : gateIntent === "skip" ? "跳过并验收"
      : input.commitChoosable && !commit ? "验收，不提交"
        : "确认验收";
  const confirmDisabled = (input.commitChoosable && !commitKnown)
    || batchNeedsCommit
    || input.verification === "loading" || input.verification === "error" || input.verification === "unacknowledged";
  return {
    runs,
    commit,
    batchNeedsCommit,
    confirmLabel,
    confirmDisabled,
    gateIntent,
    commitParam: input.commitChoosable ? commit : undefined,
  };
}

/** 「清理」那一步照实际会发生的写。 */
export function cleanText(steps: Extract<AcceptanceSteps, { kind: "merge" }>, commit: boolean): string {
  const tree = steps.scope === "team" ? "团队 worktree" : steps.scope === "duet" ? "讨论 worktree" : "worktree";
  if (steps.clean === "none") return `${tree}和分支都保留`;
  const keepsBranch = steps.merge !== "safe" || !commit;
  return steps.clean === "worktree" || keepsBranch ? `${tree}，分支留着` : `${tree}和任务分支`;
}
