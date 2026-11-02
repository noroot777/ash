// 会话区的选文浮条 + 「添加到备忘」那一颗。**任务级能力，不是某一页的按钮**：
// 普通任务详情（TaskDetail）和团队调度台（TeamView）各有一套自己的主会话，但「选中一段
// 留给自己回头看」在哪种任务里都该有，两边的接法也必须一样 —— 所以收在这里一份。
//
// 写入落进同一个模块级 store（taskMemoStore.ts），存上之后把备忘那一格切过来：浮条在
// 中间栏、面板在侧栏，不切的话用户按完什么都看不见。
import type { ReactNode } from "react";
import { ConversationSelection } from "../side-chat/ConversationSelection.tsx";
import type { Notify } from "../lib/notify.ts";
import { addTaskMemo } from "./taskMemoStore.ts";

export function MemoSelectionScope({ taskId, openTab, notify, onAsk, onAddToReply, children }: {
  taskId: string;
  /** InspectorHost 给的切格函数：存完切到 "memos"。 */
  openTab: (tabId: string) => void;
  notify: Notify;
  /** 不传 = 这一页没有侧聊那一格（团队调度台就没有），浮条上不出那一颗。 */
  onAsk?: () => void;
  /** 不传 = 这个任务没有可用的对话框（比如已交接出去）。 */
  onAddToReply?: (text: string) => void;
  children: ReactNode;
}) {
  return (
    <ConversationSelection
      key={taskId}
      taskId={taskId}
      onAsk={onAsk}
      onAddToReply={onAddToReply}
      // **先存下来再切面板**：存失败时不该把人甩到一个什么都没多出来的面板上，只留一句
      // toast 让他自己猜。几十毫秒的事，换的是「切过去就看得见」。
      onAddToMemo={(text) => void (async () => {
        try {
          await addTaskMemo(taskId, text);
          openTab("memos");
        } catch (reason) {
          notify(reason instanceof Error ? reason.message : String(reason));
        }
      })()}
    >
      {children}
    </ConversationSelection>
  );
}
