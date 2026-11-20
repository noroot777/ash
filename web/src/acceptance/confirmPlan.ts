import type { AcceptanceSteps } from "@navi/shared/accept-message";
import type { AcceptMemoryWrite } from "@navi/shared/accept-gate";

/**
 * 确认层「这一按会做什么」的推导。纯函数：画法在 AcceptConfirm.tsx，这里只管
 * 「勾成这样 → 一步一行写什么、确认键叫什么、能不能按、发给后端的参数是什么」。
 *
 * 两个勾的默认是**上一次真的确认验收时的样子**（用户 2026-11-15 要的：别每个任务都重新去掉一次；
 * 11-16 曾改成「运行」不记、跳过只管当次（bb69db55），当天用户说选错了，撤回成记住）。
 * 只开关这一层、动了勾又关掉不算；点确认才记（memory），记住了什么前提列那一行照样说得出来（gateLine.ts），
 * 所以它不是一个没人记得设过的隐形开关。
 *  - 「运行」：已有一次还作数的绿时默认不勾（沿用那次），勾上 = 重跑，这两样都不改记住的值；否则默认跟
 *    上一次（skipRemembered：上次跳过就不勾），取消 = 这次跳过。
 *  - 「提交」：默认就是项目设置，确认时写回项目设置（一处改了另一处跟着变）。发给后端的是**这一层里
 *    看到的那个值**，不让后端再读一次项目设置。
 *  - 「推送」：只在会落提交、目标分支有远程时出现（不提交就没有可推的，取消「提交」它就收起来），默认跟上一次。
 *    后端只认这一次明说的 push，不读任何默认 —— 推送是往外发。
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
  /** 上一次在这个项目里确认验收时取消了「运行」。 */
  skipRemembered: boolean;
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
   * 前置命令那份状态（命令、上一次结果、记住的「跳没跳过」）正在重读或重读失败：手上那份只管画，读到之前
   * 不许确认 —— 别处刚确认成「要运行」，这里拿旧的「跳过」去确认会照旧跳过、还把它写回去（第 3、4 轮审查；
   * 用户 2026-11-15 选的：确认层开着时宁可灰一下）。与 commitDefaultPending 同一条不变量。
   */
  gatePending?: boolean;
  /** 一次验收几个任务（父任务 + 勾上的派生任务）；1 = 只验这一个。 */
  count: number;
  /** 独立验证尚未执行：要先勾「知情」。 */
  verification: "none" | "loading" | "error" | "unacknowledged" | "acknowledged";
  /** 「推送」那一步：这一按推得了（推到哪读回来了）时给上一次勾没勾；不给 = 这一按不提供推送。 */
  push?: { remembered: boolean } | null;
  /** 「推送」那一勾；null = 没动过，跟上一次。 */
  pushChoice?: boolean | null;
  /** 推送那份事实还在读或读失败（只在会提交时拦）：上一次勾了推送，读不到就不能静悄悄不推。 */
  pushPending?: boolean;
};

export type ConfirmView = {
  runs: boolean;
  commit: boolean;
  /** 一次多个任务又不提交：只能合一个。 */
  batchNeedsCommit: boolean;
  /** 「推送」那一步画不画（会提交、而且推得了）。 */
  pushChoosable: boolean;
  push: boolean;
  confirmLabel: string;
  confirmDisabled: boolean;
  /** 发给 /accept 的那几个参数。 */
  gateIntent: "skip" | "rerun" | undefined;
  commitParam: boolean | undefined;
  pushParam: boolean | undefined;
  /** 点确认时记下的那几勾；null = 这一按没什么可记（放行、沿用或重跑、不合并）。 */
  memory: AcceptMemoryWrite | null;
};

export function confirmView(input: ConfirmInput): ConfirmView {
  const { steps, gate } = input;
  const runs = gate ? input.runChoice ?? (!gate.reusable && !gate.skipRemembered) : false;
  const gateIntent = !gate ? undefined : gate.reusable ? (runs ? "rerun" : undefined) : runs ? undefined : "skip";
  const commitKnown = input.commitDefault !== null && !input.commitDefaultPending;
  const commit = input.commitChoosable ? input.commitChoice ?? input.commitDefault ?? true : true;
  const batchNeedsCommit = input.commitChoosable && !commit && input.count > 1;
  const pushChoosable = steps.kind === "merge" && commit && !!input.push;
  const push = pushChoosable && (input.pushChoice ?? input.push!.remembered);
  const confirmLabel = steps.kind === "release" ? "放行"
    : gateIntent === "skip" ? "跳过并验收"
      : input.commitChoosable && !commit ? "验收，不提交"
        : push ? "验收并推送"
          : "确认验收";
  const confirmDisabled = (input.commitChoosable && !commitKnown)
    || input.gatePending === true
    || batchNeedsCommit
    || (input.pushPending === true && commit)
    || input.verification === "loading" || input.verification === "error" || input.verification === "unacknowledged";
  // **每一次**有资格记的确认都登记，跟默认一样也登记：服务端靠到达顺序挡住超时后迟到的旧保存，没登记的那次
  // 确认它看不见，旧的就盖过来了（第 4 轮审查）。默认可能是旧快照这件事由 gatePending / commitDefaultPending
  // 挡在确认之前，不靠「不发」来躲。
  const memory: AcceptMemoryWrite = steps.kind === "release" ? {} : {
    ...(gate && !gate.reusable ? { skipGate: !runs } : {}),
    ...(input.commitChoosable ? { commit } : {}),
    ...(pushChoosable ? { push } : {}),
  };
  return {
    runs,
    commit,
    batchNeedsCommit,
    pushChoosable,
    push,
    confirmLabel,
    confirmDisabled,
    gateIntent,
    commitParam: input.commitChoosable ? commit : undefined,
    pushParam: pushChoosable ? push : undefined,
    memory: Object.keys(memory).length ? memory : null,
  };
}

/** 「清理」那一步照实际会发生的写。 */
export function cleanText(steps: Extract<AcceptanceSteps, { kind: "merge" }>, commit: boolean): string {
  const tree = steps.scope === "team" ? "团队 worktree" : steps.scope === "duet" ? "讨论 worktree" : "worktree";
  if (steps.clean === "none") return `${tree}和分支都保留`;
  const keepsBranch = steps.merge !== "safe" || !commit;
  return steps.clean === "worktree" || keepsBranch ? `${tree}，分支留着` : `${tree}和任务分支`;
}
