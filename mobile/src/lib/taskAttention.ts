// 「这个任务在等我指挥吗」的判据。纯逻辑放在 lib：列表的年龄闸（lib/taskTree）和行内
// 的标识（components/TaskStatusChips）读的必须是同一份 —— **标出来的和留下来的必须是
// 同一批**，各写一份迟早会一边标着「等你答复」一边把它折进「显示另外 N 条」。
// 判据与 web 的 `web/src/lib/taskAttention.ts` 对应（那边叫 needsYourCommand），改一处
// 去那边同步。
import type { TaskListItem } from "@ash/shared";
import { workersOf } from "@ash/shared/team";

export type AttentionKind = "question" | "verify_failed";

/**
 * 用户打开 app 第一眼要认出来的两档：
 *   1. 有待答问题（agent 调了 ask_question，停在那儿谁也推不动）；
 *   2. 验证没通过（要么改，要么再派一轮审查）。
 * 归档任务不再等任何人，一律不标。
 */
export function attentionKind(task: TaskListItem): AttentionKind | null {
  if (task.archived) return null;
  if (task.question) return "question";
  if (task.stage === "verify_failed") return "verify_failed";
  return null;
}

/** 一批任务里各有几个在等人 —— 团队卡片要在折叠状态下替执行者喊话。 */
export function attentionCounts(tasks: TaskListItem[]): { questions: number; verifyFailed: number } {
  const kinds = tasks.map(attentionKind);
  return {
    questions: kinds.filter((kind) => kind === "question").length,
    verifyFailed: kinds.filter((kind) => kind === "verify_failed").length,
  };
}

/**
 * 「停在这儿等你指挥」。团队要**连执行者一起看**：调度台派完活自己落回 idle，问题和
 * 「验证未通过」都写在执行者身上，只读调度台那一行会把整队判成没事发生 —— 而列表上
 * 团队卡确实替执行者喊了话（TaskListRow 的「N 人等你答复」），标了就不能藏。
 *
 * 不收 paused：停在检查点是等续跑指令，行内没有跟提问同级的醒目标识，硬拉进豁免就成了
 * 「留下来的比标出来的多」，同样违反上面那条原则。web 端同此。
 */
export function needsYourCommand(task: TaskListItem, allTasks: TaskListItem[]): boolean {
  if (attentionKind(task) !== null) return true;
  if (task.mode !== "team" || task.parentId) return false;
  return workersOf(allTasks, task.id).some((worker) => attentionKind(worker) !== null);
}
