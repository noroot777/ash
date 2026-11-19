// 任务页回复框那颗发送键真正做的事：先过换执行器的确认闸，发出去，再按**结果**说一句话。
// 单独成文件是为了守住 TaskDetail 的 700 行。
import type { ComponentProps } from "react";
import type { Task, TaskListItem } from "@navi/shared";
import { api } from "../lib/api.ts";
import { createClientId } from "../lib/clientId.ts";
import { localeDateTime } from "../lib/localeFormat.ts";
import type { Notify } from "../lib/notify.ts";
import type { useConversation } from "../lib/useConversation.ts";
import type { ConfirmExecutorSwap } from "./ExecutorGate.tsx";
import type { ReplyBox } from "./ReplyBox.tsx";

type SendReply = ComponentProps<typeof ReplyBox>["onSend"];

export function replySend({ task, allTasks, conversation, confirmExecutorSwap, notify }: {
  task: Task;
  allTasks: readonly TaskListItem[];
  conversation: Pick<ReturnType<typeof useConversation>, "addUser">;
  confirmExecutorSwap: ConfirmExecutorSwap;
  notify: Notify;
}): SendReply {
  return async (text, attachments, { executorLabel: _, ...options }) => {
    if (!(await confirmExecutorSwap(task.id))) return null;
    const clientKey = createClientId();
    const result = await api.replyTask(task.id, text, { attachments, ...options, clientKey });
    // 按**结果**分支而不是按请求参数:任务正在跑时后端会把这条落成
    // 排队消息(前端没传 sendAt 也一样)。没真发出去就绝不能先贴进会话,
    // 否则用户看到自己的话已在时间线上、agent 却还没收到。
    if ("scheduled" in result) {
      // 同样按结果措辞:暂停/待办任务也会因排队未轮到被暂存(r3 审查),
      // 对它说「任务进行中」是错的。
      notify(result.message.mode === "queued"
        ? (task.status === "running" || task.status === "queued"
          ? "任务进行中，已排队；这一轮结束后自动发出"
          : "任务在队列中等待，已排队；轮到它时自动发出")
        : result.message.mode === "after"
          ? `已安排在「${allTasks.find((item) => item.id === result.message.afterTaskId)?.title || "所选任务"}」完成后发送`
          : `已安排 ${localeDateTime(result.message.sendAt)} 发送`);
      return result;
    }
    if ("command" in result) {
      notify(result.recorded ? "原生命令已执行，结果见会话记录" : result.text);
      return result;
    }
    conversation.addUser(text, attachments, { clientKey });
    notify(options.agent
      ? `已召唤 @${options.agent}${options.model ? ` · ${options.model}` : ""}${options.reasoningEffort ? ` · ${options.reasoningEffort}` : ""} 继续任务`
      : "回复已发送");
    return result;
  };
}
