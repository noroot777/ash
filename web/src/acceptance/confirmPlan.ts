import type { AcceptanceSteps } from "@ash/shared/accept-message";
import type { AcceptMemoryWrite } from "@ash/shared/accept-gate";

/**
 * 确认层「这一按会做什么」的推导。纯函数：画法在 AcceptConfirm.tsx，这里只管
 * 「勾成这样 → 一步一行写什么、确认键叫什么、能不能按、发给后端的参数是什么」。
 *
 * 两个勾各有各的默认，只开关这一层、动了勾又关掉都不算：
 *  - 「运行」**不记上一次**（用户 2026-11-16：记住的那几天里取消过一次就次次默认跳过，门禁等于没设）。
 *    没有可沿用的绿时默认勾着，取消 = 只这一次跳过；已有一次还作数的绿时默认不勾（沿用那次），勾上 =
 *    一次性重跑。
 *  - 「提交」：默认就是项目设置，确认时写回项目设置（memory；一处改了另一处跟着变）。发给后端的是
 *    **这一层里看到的那个值**，不让后端再读一次项目设置。
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
  /** 项目默认（最近读到的那份，只管画勾）；null = 一次都还没读到。 */
  commitDefault: boolean | null;
  /**
   * 项目默认正在读、正在重读（别处刚改过、断线重连）或读失败：读到之前不许确认。**手动改过这一勾也一样**
   * —— 读不出来说明这一刻连项目都可能对不上，不拿「用户动过」当豁免（第 2 轮审查 F2）。
   */
  commitDefaultPending?: boolean;
  /**
   * 前置命令那份状态（命令、上一次结果）正在重读或重读失败：手上那份只管画，读到之前不许确认 —— 层里写的
   * 「运行哪一条 / 沿用哪一次 / 上次未通过 / 会撞冲突」都出自它，别处刚改过时这一按照的就是一份旧的
   * （用户 2026-11-15 选的：确认层开着时宁可灰一下）。与 commitDefaultPending 同一条不变量。
   */
  gatePending?: boolean;
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
  /** 点确认时写回项目设置的「提交」那一勾；null = 这一按没什么可记（放行、不合并）。 */
  memory: AcceptMemoryWrite | null;
};

export function confirmView(input: ConfirmInput): ConfirmView {
  const { steps, gate } = input;
  const runs = gate ? input.runChoice ?? !gate.reusable : false;
  const gateIntent = !gate ? undefined : gate.reusable ? (runs ? "rerun" : undefined) : runs ? undefined : "skip";
  const commitKnown = input.commitDefault !== null && !input.commitDefaultPending;
  const commit = input.commitChoosable ? input.commitChoice ?? input.commitDefault ?? true : true;
  const batchNeedsCommit = input.commitChoosable && !commit && input.count > 1;
  const confirmLabel = steps.kind === "release" ? "放行"
    : gateIntent === "skip" ? "跳过并验收"
      : input.commitChoosable && !commit ? "验收，不提交"
        : "确认验收";
  const confirmDisabled = (input.commitChoosable && !commitKnown)
    || input.gatePending === true
    || batchNeedsCommit
    || input.verification === "loading" || input.verification === "error" || input.verification === "unacknowledged";
  // **每一次**会合并的确认都登记，跟默认一样也登记：服务端靠到达顺序挡住超时后迟到的旧保存，没登记的那次
  // 确认它看不见，旧的就盖过来了（第 4 轮审查）。默认可能是旧快照这件事由 commitDefaultPending 挡在确认之前，
  // 不靠「不发」来躲。「运行」那一勾不在里面：它不记。
  const memory: AcceptMemoryWrite | null = steps.kind !== "release" && input.commitChoosable ? { commit } : null;
  return {
    runs,
    commit,
    batchNeedsCommit,
    confirmLabel,
    confirmDisabled,
    gateIntent,
    commitParam: input.commitChoosable ? commit : undefined,
    memory,
  };
}

/** 「清理」那一步照实际会发生的写。 */
export function cleanText(steps: Extract<AcceptanceSteps, { kind: "merge" }>, commit: boolean): string {
  const tree = steps.scope === "team" ? "团队 worktree" : steps.scope === "duet" ? "讨论 worktree" : "worktree";
  if (steps.clean === "none") return `${tree}和分支都保留`;
  const keepsBranch = steps.merge !== "safe" || !commit;
  return steps.clean === "worktree" || keepsBranch ? `${tree}，分支留着` : `${tree}和任务分支`;
}
