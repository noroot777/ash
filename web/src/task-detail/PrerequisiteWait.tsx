// 会话里「在等」那一行：要它开工了、还没开工时写在等什么。前置还没站稳就写在等谁、那条到哪一步了，点名字
// 跳过去；前置都齐了（或者没有前置，分组运行、派活单要它开工）就写服务端说的那件事（同组名额满了、分组暂停着…）。
// 一变服务端就把这条任务重发一遍（prerequisite-view.ts），这一行跟着换字，不用自己轮询。
// 只有要你动手的那几步上色（prerequisiteNeedsUser）；前置都齐了却开不了工的，写原因。
import type { TaskPrerequisites } from "@ash/shared/prerequisites";
import { prerequisiteNeedsUser, prerequisiteStepText } from "@ash/shared/prerequisites";
import "./prerequisite-wait.css";

export function PrerequisiteWait({ view, onOpenTask }: { view: TaskPrerequisites; onOpenTask?: (taskId: string) => void }) {
  if (view.blocked) {
    return <div className="live-strip prereq-wait" role="status"><span className="prereq-wait-attn">开不了工：{view.blocked}</span></div>;
  }
  const open = view.prerequisites.filter((link) => link.step !== "settled");
  if (!open.length) {
    return (
      <div className="live-strip prereq-wait" role="status">
        <span className="live-strip-label">{view.holdup ? "在等" : "马上开工"}</span>
        {view.holdup && <span className="prereq-wait-item">{view.holdup}</span>}
      </div>
    );
  }
  return (
    <div className="live-strip prereq-wait" role="status">
      <span className="live-strip-label">在等</span>
      {open.map((link) => (
        <span key={link.taskId} className="prereq-wait-item">
          {onOpenTask
            ? <button type="button" className="prereq-wait-link" onClick={() => onOpenTask(link.taskId)}>「{link.title}」</button>
            : <span>「{link.title}」</span>}
          <span className={prerequisiteNeedsUser(link.step) ? "prereq-wait-attn" : undefined}>· {prerequisiteStepText(link)}</span>
        </span>
      ))}
    </div>
  );
}
