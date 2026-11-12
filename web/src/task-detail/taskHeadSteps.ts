import type { Task } from "@ash/shared";

/**
 * 任务头右边那几颗图标各在什么时候出现（docs/ui-ux-audit head-1、reply-6）。
 *
 * 两样东西：此刻轮到你的那一步（重试 / 运行 / 继续），和验收的那枚章。任务在跑、在排队、在等你
 * 答复时这两样都不画——停止是回复框那颗发送键，等答复要你做的是会话下面那张提问卡。
 *
 * 判据照改版前那颗主按钮（primaryAction / terminalRerunAction）逐条搬过来，只是不再把「已验收」
 * 「验证中」「等答复」这些状态写成一颗灰掉的按钮：状态在侧栏那一行和右侧「信息」里看。
 */
export type HeadStep = { kind: "retry" | "run" | "resume"; label: string; tip?: string };

/** 头上「轮到你的那一步」。可能同时有章（自由工作流失败 / 取消了也能直接验收上一版）。 */
export function headSteps(task: Task): HeadStep[] {
  // 归档的任务回来走更多菜单里的「取消归档」；接力出去的任务在本机是存档，运行 / 重试由服务端
  // handoff 守卫 409，要在本机继续走横幅上的「在本机继续」。
  if (task.archived || task.handoff?.direction === "out") return [];
  if (task.status === "running" || task.status === "queued") return [];
  // 就地验证轮还没出结论、或有待答复的提问：要你做的事不在头上。
  if (task.verifyRound != null || task.question) return [];
  if (task.status === "failed") return [{ kind: "retry", label: "重试", tip: "重试 · 从中断处接着跑" }];
  if (task.status === "canceled" || task.status === "backlog") return [{ kind: "run", label: "运行" }];
  // 它自己停在检查点上（多半在等哨兵）：继续就是拿它留下的那句续跑指令接着跑。
  if (task.status === "paused") return [{ kind: "resume", label: "继续" }];
  return [];
}

/** 验收的那枚章：空心是做完了等你验，实心是验过了；null 是不画。 */
export function sealState(task: Task): "open" | "done" | null {
  if (task.handoff?.direction === "out") return null;
  if (task.stage === "accepted") return "done";
  if (task.archived) return null;
  if (task.status === "running" || task.status === "queued") return null;
  // 验证结论会覆盖 accepted、答复会往一个已合并的 worktree 里续写：这两种时候后端 acceptanceGuard
  // 必然 409，章不画（改版前是一颗灰掉的「验证中」「等答复」）。
  if (task.verifyRound != null || task.question) return null;
  // 做完的团队执行者由团队整体验收（改版前那颗是灰掉的「已完成」）。
  if (task.parentId !== null && task.status === "done") return null;
  if (task.status === "done" || task.stage === "awaiting_acceptance" || task.stage === "verified") return "open";
  // 自由工作流的 failed / canceled 同样可验收（修复失败 / 手停后接受上一版直接合并，后端
  // acceptTask 已放行；时间线也承诺「由你决定验收」）。
  if (task.workflowMode === "free" && (task.status === "failed" || task.status === "canceled")) return "open";
  return null;
}
