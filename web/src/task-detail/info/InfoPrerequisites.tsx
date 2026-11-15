// 「信息」格里的前置：一行「前置」列出它建在哪几条上、各自到哪一步了；一行「下游」列出建在它上面的。
// 点名字打开那条任务。没有前置也没有下游时两行都不出。只有要你动手的那几步上色。
import type { Task } from "@ash/shared";
import { prerequisiteNeedsUser, prerequisiteStepText } from "@ash/shared/prerequisites";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { InspRow } from "../../inspector/parts.tsx";

export function InfoPrerequisites({ task, onOpenTask }: { task: Task; onOpenTask: (taskId: string) => void }) {
  const view = task.prerequisites;
  if (!view) return null;
  const link = (taskId: string, title: string) => (
    <button type="button" className="insp-val" aria-label={`打开「${title}」`} onClick={() => onOpenTask(taskId)}>
      <span className="insp-cut">{title}</span>
      <ArrowSquareOut size={12} aria-hidden="true" />
    </button>
  );
  return (
    <>
      {view.prerequisites.map((item, index) => (
        <InspRow key={item.taskId} label={index === 0 ? "前置" : ""}>
          {link(item.taskId, item.title)}
          <span className={`insp-cut ${prerequisiteNeedsUser(item.step) ? "insp-attn" : "insp-faint"}`}>{prerequisiteStepText(item)}</span>
        </InspRow>
      ))}
      {view.dependents.map((item, index) => (
        <InspRow key={item.taskId} label={index === 0 ? "下游" : ""}>{link(item.taskId, item.title)}</InspRow>
      ))}
    </>
  );
}
