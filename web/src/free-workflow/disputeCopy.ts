import type { FreeReviewDispute } from "@ash/shared";

/**
 * 裁定这一段所有**写给用户的字**，集中在这里。
 *
 * 为什么单独一个文件：这一屏的毛病从来不是缺功能，是没人能读懂（用户 2026-10-20：
 * 「让用户裁定时要说人话，现在一大篇文字都看不懂」）。措辞是这一屏的主体，和渲染结构
 * 混在一个文件里，每次调一个词都要在 JSX 里翻；拆出来还能让回归直接对文案下断言。
 *
 * 写作口径，改这里的字时照着来：
 * ① **讲接下来会发生什么，不讲这是哪个状态**。「它立刻拿着报告继续改」比「维持审查意见」
 *    有用——后者是记录里的名字，不是用户要做的决定。
 * ② **不出现只有看代码的人才懂的词**：后端、审查链、run、旁路回合、一等状态。用户不知道
 *    这些东西存在，也不该为了拍板去学。
 * ③ 记录里的叫法（「维持审查意见 / 采纳执行者说法」）只在审查记录和时间线里出现，回复框顶上
 *    那一行和它的提示里不出现（用户 2026-11-15 定的：先选一档、再按写着动作的键，这两步就是
 *    确认，不再弹确认框，确认框末尾那行「时间线上记作…」随之不要了）。
 */

/**
 * 三档裁定和「让双方辩论」各自的文案。按钮只写**动作**，不写「谁对」（用户 2026-09-27 拍的板，原话
 * 不改）：上一版叫「维持意见并修复 / 采纳执行者说法」——那是裁判用语，回答的是谁赢；而用户真正
 * 要做的是下一步的指令。辩论辩出「第 2 条成立，但按后来达成的新方案做」时，两颗都不对。
 *
 * - `tip`：指到那一颗时浮出的那句——**我什么时候该点它**，以及按下去会发生什么（原来确认框里那段）。
 * - `placeholder`：选中这一档后输入框里的提示，要交代的话都是选填。
 * - `send`：发送键上的字，就是这一按的名字。
 */
export const RESOLUTIONS = {
  upheld: {
    button: "让它接着改",
    tip: "审查说得对 —— 它马上按第 {round} 轮报告接着改。写了要点就按你的要点改，留空就照报告改。",
    placeholder: "要交代给执行者的话（选填）：和报告冲突的地方以你这段为准",
    send: "发起修复",
  },
  withdrawn: {
    button: "这一轮不用改了",
    tip: "它说得对 —— 第 {round} 轮这条意见作废，执行者不用再改它。报告和截图照旧留着，也不会被改写成「已通过」。",
    placeholder: "记一笔你的理由（选填）：不发给执行者，只留在审查记录里",
    send: "作废这条意见",
  },
  deferred: {
    button: "转为独立任务",
    tip: "都对，但不该在这个任务里改 —— 新建一个待办任务（不会自动开跑），把这几条连同第 {round} 轮的报告和截图带过去。"
      + "这个任务这一轮就到这儿：它已经改好的那部分还没审过，想继续就再派一轮审查。",
    placeholder: "要交代给新任务的话（选填）：会写进新任务的描述里",
    send: "建任务并转走这几条",
  },
} as const;

export type DisputeResolutionKind = keyof typeof RESOLUTIONS;

export const DEBATE_CHOICE = {
  button: "让双方辩论",
  tip: "还拿不准 —— 让两边各说几段再定。只发言、不改代码，说完还是你来定。",
  send: "开始辩论",
} as const;

/** 「让它接着改」在辩完之后多说的那一句：辩论收尾那一段执行者结构上没见过（修复指令里会整段抄给它）。 */
export const UPHELD_AFTER_DEBATE = "辩论里审查者最后那段会一并发给它。";

export function choiceTip(kind: DisputeResolutionKind, round: number): string {
  return RESOLUTIONS[kind].tip.replace("{round}", String(round));
}

/** 「来回 1 2 3」旁边那一句：审查者先说，末尾审查者再收个尾。 */
export function exchangesText(exchanges: number): string {
  return `审查者先说，共 ${exchanges * 2 + 1} 段`;
}

/** 交完之后那一句（页面的 notify）。 */
export function resolvedText(
  kind: DisputeResolutionKind,
  round: number,
  result: { deferredTask: { title: string } | null; repairError: string | null },
  wrote: boolean,
): string {
  if (kind === "withdrawn") return `这一轮不用改了：第 ${round} 轮那条意见作废，审查记录原样保留`;
  if (kind === "deferred") return result.deferredTask ? `已转为独立任务：${result.deferredTask.title}（待办，未起跑）` : "已转为独立任务";
  return result.repairError
    ? `已让它接着改，但发起修复失败：${result.repairError}`
    : `已让它接着改：按${wrote ? "你写的要点和" : ""}第 ${round} 轮报告发起修复`;
}

/** 审查格里那一轮下面「驳回」那一段的两段依据，各自的折叠标题（点开才是那一墙技术依据）。 */
export const DISPUTE_PROSE_LABELS = {
  reason: "它凭什么说这几条不成立",
  defer: "它认可、但说该另开任务的那几条",
} as const;

/** 「裁定」那一段：哪一档（按钮原话），附的话折着。 */
export function rulingText(dispute: FreeReviewDispute): string | null {
  if (dispute.resolution) {
    return dispute.resolution === "upheld" ? RESOLUTIONS.upheld.button
      : dispute.resolution === "withdrawn" ? RESOLUTIONS.withdrawn.button : RESOLUTIONS.deferred.button;
  }
  return dispute.supersededAt ? "没有裁定，另派了一轮审查" : null;
}

/** 附的那段话折起来时的标题：三档的话各是写给谁的。 */
export function rulingNoteLabel(dispute: FreeReviewDispute): string {
  if (dispute.resolution === "withdrawn") return "附了一段理由";
  if (dispute.resolution === "deferred") return "附了一段要交代给新任务的话";
  return "附了一段要交代的话";
}
