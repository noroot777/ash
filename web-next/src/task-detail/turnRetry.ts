import type { Task } from "@harness/shared";
import type { ConversationItem } from "./conversationModel.ts";

// 「上一回合崩了」的判据，和会话尾栏那颗重试按钮共用一份。判据必须跟服务端
// `server/src/task-retry-turn.ts` 的 `retryTurnRejection` 对齐 —— 两边说法不一样，
// 按钮就成了「点了永远 409」。
//
// 存在的理由：续聊回合、自由工作流的自动修复回合非正常结束时，任务状态**不变**（服务端
// 只在正文里留一句「续聊回合异常结束(退出码 N),任务状态保持「已完成」不变」）。于是任务
// 停在 done，头部那颗「重试」不出现（它只认 failed），整页没有任何能重来的入口。
//
// 只挂在**最后一条 agent 气泡**上：会话尾巴才是「上一回合」，中间那些崩过的回合后面早
// 已经跑过别的了，给它们按钮等于骗人。
export function retryTurnSessionId(task: Task, items: ConversationItem[]): string | null {
  // duet/团队各有自己的回合形状（gate、常驻调度台），服务端也只接单飞。
  if (task.mode !== "single" || task.archived) return null;
  // 只认停在「已完成」的任务。**主动停止/分组暂停也会留下非零退出码**（CLI 吃 SIGTERM 后
  // 按 signal 写 exit 1），可那不是崩溃，它们的入口是头部那颗「运行」；failed 也归头部那颗
  // 「重试」。除了 done，其余状态在这儿一律不给按钮。
  if (task.status !== "done") return null;
  // 就地验证轮还挂着号 = 那一轮没出结论，它是旁路回合，重跑它得走验证那条路。
  if (task.verifyRound != null) return null;
  const last = [...items].reverse().find((item) => item.kind === "agent");
  if (last?.kind !== "agent") return null;
  // 审查/验证的旁路会话不归这颗按钮管：服务端只会把重投投回**同一条**会话，reviewer 的
  // 身份和轮次这里拿不回来，自由审查链自己会重派。
  if (last.session && last.session.role !== "single") return null;
  const exit = last.session?.exitStatus;
  // exitStatus 为 null = 回合还没结算（或 server 重启时断的），那不是「异常结束」，
  // 别拿它当崩溃 —— 那种情况任务本身会是 failed，走上面那条路。
  return exit != null && exit !== 0 ? last.session?.id ?? null : null;
}
