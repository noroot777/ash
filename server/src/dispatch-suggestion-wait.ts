// 等着的那一批（wait = done / continue，shared/src/dispatch-suggestion.ts 文件头）在服务端的几段话和收尾：
//   · 摆出来时写进 `task.question` 的那一句清单（`planQuestionText`）：网页上框顶画成一行行，这句话是给
//     不认识它的地方看的（手机、飞书、问答历史里的引文）——看得出在等什么，回一句话就是「发回去改」；
//   · 处理完那一下留在问答记录里的两段：用户答的那一句（`launchBubble`）和交给智能体的清单（`launchReply`）。
// 处理完是哪一笔、怎么跟建任务同一笔提交，在 dispatch-suggestion-resolve.ts；done 欠下的那一下收尾怎么还，在
// dispatch-suggestion-settle.ts。
import { dispatchDefaultTarget, parseDispatchTarget, sameDispatchTarget, type DispatchRunTarget } from "@navi/shared/dispatch-target";
import {
  DISPATCH_LAUNCH_REPLY_LEAD, DISPATCH_ORDER_LABEL, type DispatchOrder, type StoredSuggestion,
} from "@navi/shared/dispatch-suggestion";
import type { AgentType } from "@navi/shared";
import { db } from "./db/index.js";
import { agents } from "./db/schema.js";
import type { TaskRow } from "./task-store.js";

export const DISPATCH_WAIT_BLOCKS_ASK =
  "这一回合已经摆了一批派活在等用户过目，不能再提问：同一时刻只等用户一样东西。要问的话写进那几件的说明里，或等用户回了再问";
export const QUESTION_BLOCKS_DISPATCH_WAIT =
  "这条任务已经有一个提问在等用户答复，不能再摆要等的一批派活：同一时刻只等用户一样东西。等用户答了再摆，或用 wait=none 挂着不等";

/** 交给谁读成一个名字：执行器名，没有就类型名；模型、智能水平跟在后面。 */
export type TargetLabel = (target: DispatchRunTarget) => string;

/** 交给谁读成一句人话：执行器名（没钉 profile 时取该类型的默认执行器名），模型、智能水平跟在后面。 */
export async function targetLabeler(): Promise<TargetLabel> {
  const profiles = await db.select({ id: agents.id, name: agents.name, type: agents.type, isDefault: agents.isDefault }).from(agents);
  return (target) => {
    const name = profiles.find((profile) => profile.id === target.executorId)?.name
      ?? profiles.find((profile) => profile.type === target.agentType && profile.isDefault)?.name
      ?? target.agentType;
    return [name, target.model, target.reasoningEffort].filter(Boolean).join(" · ");
  };
}

/** 那一行「交给谁」的初始值：智能体指明的那个，没指明就是这条任务「派出去的活交给谁」。 */
export function proposedTarget(task: TaskRow): (item: Pick<StoredSuggestion, "target">) => DispatchRunTarget | null {
  const fallback = dispatchDefaultTarget({
    ...task, agentType: task.agentType as AgentType | null, dispatchTarget: parseDispatchTarget(task.dispatchTarget),
  });
  return (item) => item.target ?? fallback;
}

export function planQuestionText(order: DispatchOrder, items: readonly StoredSuggestion[], who: (item: StoredSuggestion) => string): string {
  const lines = items.map((item, index) => `${index + 1}. ${item.title}${item.note ? ` —— ${item.note}` : ""}（交给 ${who(item)}）`);
  return [`派出这 ${items.length} 个任务（${DISPATCH_ORDER_LABEL[order]}）：`, ...lines].join("\n");
}

/** 等着的那一批里了结了的一件：派出去的（task）或点叉的。 */
type Settled = StoredSuggestion & { settled: NonNullable<StoredSuggestion["settled"]> };

/**
 * 问答记录里用户答的那一句：「派出这 N 个任务」，下一行一句改动——怎么排、第几条换了人、去掉了哪几条。
 * 第几条按派出去的先后数。一条没派（全点叉了）时就说这一句。
 */
export function launchBubble(batch: readonly Settled[], order: DispatchOrder, proposedOf: (item: StoredSuggestion) => DispatchRunTarget | null, label: TargetLabel): string {
  const launched = batch.filter((item) => item.settled.task);
  const dropped = batch.filter((item) => !item.settled.task);
  if (!launched.length) return `这 ${batch.length} 个任务一个都没派（全部去掉了）`;
  const changes = [DISPATCH_ORDER_LABEL[order]];
  launched.forEach((item, at) => {
    const target = item.settled.task!.target;
    if (!sameDispatchTarget(proposedOf(item), target)) changes.push(`第 ${at + 1} 条交给 ${label(target)}`);
  });
  if (dropped.length) changes.push(`去掉了${dropped.map((item) => `「${item.title}」`).join("")}`);
  return `派出这 ${launched.length} 个任务\n${changes.join(" · ")}`;
}

/**
 * 交给智能体的那段话：建好了哪几条（任务号、标题、交给了谁），去掉了哪几条，别再建一遍。`settledDone` = 派完就算完成：
 * 这段不是续上会话的答复，是它下一回合开头才收到的补交，所以不带【答复】、写明这条任务已经替它结成了完成。
 * 建了任务的那种以 `DISPATCH_LAUNCH_REPLY_LEAD` 开头，那条问答记录带 `dispatchLaunch`（建好的清单），会话里据此认出它、不画成
 * 气泡（那一下由「开了新任务」说）；全点叉了的那种照常画：会话里没有别的地方说过这件事。
 */
export function launchReply(batch: readonly Settled[], order: DispatchOrder, label: TargetLabel, settledDone: boolean): string {
  const launched = batch.flatMap((item) => (item.settled.task ? [item.settled.task] : []));
  const dropped = batch.filter((item) => !item.settled.task).map((item) => `「${item.title}」`);
  const done = settledDone ? "本任务按你摆单时说定的（派完就算完成）随即结成了完成，当时没有叫醒你。" : "";
  const head = settledDone ? [] : ["【答复】"];
  if (!launched.length) {
    return [...head, `用户把你摆的这一批（${batch.length} 个任务）全部去掉了，一条都没建：${dropped.join("、")}。${done}`].join("\n");
  }
  const built = `${DISPATCH_LAUNCH_REPLY_LEAD}Navi 已照${settledDone ? "你上次摆的" : ""}那一批此刻的样子建好下面 ${launched.length} 个任务`
    + `（${DISPATCH_ORDER_LABEL[order]}），挂在本任务名下、已交给调度（可能还在等名额、等前置或排队）。`;
  return [
    ...head,
    `${built}${done}不要再调用建任务的工具重复建；要看进度用 list_tasks / get_task。`,
    ...launched.map((task, index) => `${index + 1}. ${task.id}「${task.title}」→ ${label(task.target)}`),
    ...(dropped.length ? [`用户去掉了：${dropped.join("、")}（没有建）`] : []),
  ].join("\n");
}
