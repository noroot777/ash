import { useState } from "react";
import type { Task, TaskListItem } from "@ash/shared";
import { Play, Stop } from "@phosphor-icons/react";
import { InspectorHeadActions } from "../../inspector/index.ts";
import { InspTool } from "../../inspector/parts.tsx";
import { api } from "../../lib/api.ts";
import type { Notify } from "../../lib/notify.ts";

// 「派出的任务」格头那一颗：全部停下 / 接着跑（服务端 server/src/dispatch-hold.ts）。
//
// 没停着时指到格头才出（键盘走进这一格、触屏上常驻，见 dispatched.css）；名下没有在跑也没有排着的
// 就不出。停着时它是「接着跑」，常驻 —— 停过这件事得一眼看得出来，刷新之后也一样（状态记在服务端）。
// 按了拿回来的是派活那条任务的新快照，交给上层合进任务列表；别的窗口经 SSE 跟着变。
export function DispatchHoldKey({ task, live, onTaskUpdated, notify }: {
  task: Pick<TaskListItem, "id" | "dispatchHoldAt">;
  /** 名下（整棵往下）有在跑或排着的。 */
  live: boolean;
  onTaskUpdated: (task: Task) => void;
  notify: Notify;
}) {
  const [pending, setPending] = useState(false);
  const held = !!task.dispatchHoldAt;
  if (!held && !live) return null;
  const press = async () => {
    setPending(true);
    try {
      onTaskUpdated(await (held ? api.releaseDispatched(task.id) : api.holdDispatched(task.id)));
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <InspectorHeadActions>
      <InspTool
        label={held ? "接着跑" : "全部停下"}
        tip={held ? "接着跑：停下的那几条从原处续上" : "全部停下：名下在跑的停下，排着的不再起跑"}
        className={`dispatched-hold-key${held ? " is-held" : ""}`}
        disabled={pending}
        onClick={() => void press()}
      >
        {held ? <Play weight="fill" aria-hidden="true" /> : <Stop weight="fill" aria-hidden="true" />}
      </InspTool>
    </InspectorHeadActions>
  );
}
