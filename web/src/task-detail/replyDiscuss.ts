// 回复框里「讨论」那一按真正做的事：叫上的人和这条任务的执行器来回几段（server/src/discussion.ts）。
// 单独成文件守 TaskDetail 的 700 行，跟「问一句」（replySend.ts）、「派出去」（replyDispatch.ts）对称。
//
// 发出去的话不进这条任务的会话：它是讨论的话题，落在讨论那一场的记录里，会话里由讨论气泡上方那一句画出来。
import type { Task } from "@navi/shared";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import type { ReplyBoxProps } from "./replyBoxProps.ts";

type Discuss = NonNullable<ReplyBoxProps["onDiscuss"]>;

export function replyDiscuss({ task, onChanged }: {
  task: Pick<Task, "id">;
  /** 开起来了：自由工作流状态换成服务端回的那一份（气泡、「审议」格当场就有这一场）。 */
  onChanged: (state: FreeWorkflowApiState) => void;
}): Discuss {
  return async ({ topic, attachments, rounds, people }) => {
    const result = await api.startDiscussion(task.id, {
      topic,
      attachments,
      rounds,
      guests: people.map((person) => ({
        agentType: person.agent,
        executorId: person.executorId,
        model: person.model,
        reasoningEffort: person.reasoningEffort,
      })),
    });
    onChanged(result.state);
  };
}
