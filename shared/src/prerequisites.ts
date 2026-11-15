// 任务的「前置」：这条任务建在哪几条任务上面。前置全部站稳就自动起跑，开工时手里有全部前置的代码。
//
// 判定（站没站稳、到哪一步了）在服务端 `prerequisite-standing.ts`，这里只放两端共用的形状和那一句话。
// 队列是另一件事：队列管「一个接一个跑」，不传代码；前置管「后一条要前一条的代码」。

/** 一条前置此刻到哪一步了。只有 `settled` 算站稳。 */
export type PrerequisiteStep =
  /** 执行完、审查也走完了（或者没预约审查），审过的就是现在的代码；验收合入的也在这一档。 */
  | "settled"
  | "not_started"
  | "running"
  /** 停在检查点、在等哨兵这类会自己回来的暂停。 */
  | "paused"
  /** 在等人答复它的提问。 */
  | "question"
  /** 预约了审查、还没开始。 */
  | "review_reserved"
  | "reviewing"
  /** 审查没过，执行者在按意见修。 */
  | "repairing"
  /** 审查没过（轮数用完、或审查没给出结论），在等用户决定。 */
  | "review_failed"
  /** 执行者驳回了审查意见，在等用户裁定。 */
  | "review_disputed"
  /** 审查之后代码又改过，还没重新审。 */
  | "review_stale"
  /** 工作区里有没提交的改动：下游只能从提交拿代码，这些改动带不过去。 */
  | "dirty"
  | "failed"
  | "canceled"
  | "archived";

export interface PrerequisiteLink {
  taskId: string;
  title: string;
  step: PrerequisiteStep;
  /** 审查相关那几步是第几轮；其余为 null。 */
  round: number | null;
  /** 下游开工之后，这条前置又有了新提交（下游手里那份已经不是它的最新代码）。 */
  movedOn: boolean;
}

export interface TaskPrerequisites {
  /** 这条任务建在哪几条上面，按加上的先后排。 */
  prerequisites: PrerequisiteLink[];
  /** 谁建在这条任务上面。 */
  dependents: { taskId: string; title: string }[];
  /** 已经被要求起跑、在等前置站稳（「等齐就起」那一笔还挂着）。 */
  waiting: boolean;
  /** 前置都站稳了却起不了跑的原因（几条前置的改动合不到一起）。null = 没被挡。 */
  blocked: string | null;
  /** 开工起点已经按前置定下来了；之后不能再加减前置。 */
  launched: boolean;
}

/** 这几步要用户出手，别的都会自己往下走。界面只给这几种上色。 */
export function prerequisiteNeedsUser(step: PrerequisiteStep): boolean {
  return step === "question" || step === "review_failed" || step === "review_disputed"
    || step === "review_stale" || step === "dirty" || step === "failed" || step === "canceled" || step === "archived";
}

/** 一条前置此刻到哪一步了，一句话（不带任务名，任务名由调用方摆成链接）。 */
export function prerequisiteStepText(link: Pick<PrerequisiteLink, "step" | "round" | "movedOn">): string {
  const round = link.round ? `第 ${link.round} 轮` : "";
  switch (link.step) {
    case "settled": return link.movedOn ? "开工后又有新提交" : "已站稳";
    case "not_started": return "还没开始";
    case "running": return "在跑";
    case "paused": return "暂停中";
    case "question": return "在等答复";
    case "review_reserved": return "等审查开始";
    case "reviewing": return `在审${round}`;
    case "repairing": return `${round}审查没过，在修`;
    case "review_failed": return `${round}审查没过，等你决定`;
    case "review_disputed": return "审查意见被驳回，等你裁定";
    case "review_stale": return "审查后又改过，等重新审查";
    case "dirty": return "有没提交的改动";
    case "failed": return "失败了";
    case "canceled": return "已取消";
    case "archived": return "已归档";
  }
}
