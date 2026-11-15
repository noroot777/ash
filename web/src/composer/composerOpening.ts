// 新建框里 `@` 了一个人：任务建好之后第一回合怎么起。任务还是胶囊上那个执行器的，被叫的人只管开头这一下：
// - 问一句：第一句交给他答（同回复框的一次性召唤，api.replyTask 带 agent），下一句回到这条任务自己的执行器；
// - 讨论：以一场讨论开头（同回复框的讨论，server/src/discussion.ts），各方是这条任务的执行器加被叫的人，
//   说完由这条任务的执行器在主会话里写合稿。
// 没有「派出去」：要他来跑这条任务，在胶囊上选他就是了。
import type { Task } from "@ash/shared";
import { api } from "../lib/api.ts";
import { forkTaskBody, type ConversationFork } from "../task-detail/conversationFork.ts";
import { discussPeople, type ReplyCall } from "../task-detail/replyCall.ts";

/** 新建框里能做的两种（回复框还多一种「派出去」）。 */
export const COMPOSER_CALL_ABILITY = { dispatchable: false, discussable: true } as const;

export type ComposerOpening = {
  /** 建好之后起第一回合（代替「创建并运行」那一下 runTask）。 */
  start: (task: Task) => Promise<unknown>;
  /** 起成了之后那一句提示。 */
  started: string;
};

export function composerOpening(call: ReplyCall, { body, fork, attachments }: {
  body: string;
  fork: ConversationFork | undefined;
  attachments: string[];
}): ComposerOpening {
  if (call.verb === "discuss") {
    const people = discussPeople(call);
    return {
      // 派生来的新任务：背景（来源任务那场对话）只在任务正文里，讨论的各方读的是话题，所以话题带上它。
      start: (task) => api.startDiscussion(task.id, {
        topic: fork ? forkTaskBody(fork, body) : body.trim(),
        attachments,
        rounds: call.rounds,
        guests: people.map((person) => ({
          agentType: person.agent,
          executorId: person.executorId,
          model: person.model,
          reasoningEffort: person.reasoningEffort,
        })),
      }),
      started: `任务已创建，和 ${people.map((person) => person.agent).join("、")} 的讨论开始了`,
    };
  }
  const { target } = call;
  return {
    start: (task) => api.replyTask(task.id, body.trim(), {
      attachments,
      agent: target.agent,
      executorId: target.executorId,
      model: target.model,
      reasoningEffort: target.reasoningEffort,
    }),
    started: `任务已创建，第一句交给 ${target.agent} 答`,
  };
}
