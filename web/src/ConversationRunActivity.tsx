import type { Task } from "@harness/shared";
import { runActivityPhase, type RunActivityTail } from "./runActivityCopy";
import type { ConvItem } from "./Conversation";
import { executorLabel } from "./executorLabel";
import { RunActivity } from "./RunActivity";

function conversationTail(items: ConvItem[]): RunActivityTail {
  const last = items.at(-1);
  if (!last) return "empty";
  if (last.kind === "user") return "user";
  if (last.kind !== "agent") return "other";
  return last.endedAt ? "agent-ended" : "agent-active";
}

export function ConversationRunActivity({
  task,
  items,
  queueSize,
}: {
  task: Task;
  items: ConvItem[];
  queueSize: number | null;
}) {
  const phase = runActivityPhase(task.status, conversationTail(items));
  if (!phase) {
    return items.length === 0
      ? <p className="font-sans text-faint">点击「运行」开始，输出会实时流式显示在这里。</p>
      : null;
  }
  return (
    <RunActivity
      status={task.status}
      mode={task.mode}
      phase={phase}
      executor={executorLabel({ task })}
      queuePosition={task.queuePosition}
      queueSize={queueSize}
    />
  );
}
