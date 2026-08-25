import { useEffect, useState } from "react";
import type { TaskListItem } from "@ash/shared";
import type { Waiting } from "@ash/shared/team";
import { ChatCircleDots, SpinnerGap } from "@phosphor-icons/react";
import { formatDuration } from "../task-detail/utils.ts";

function waitingDuration(since: string | null, now: number): string {
  if (!since) return "时间未知";
  const started = Date.parse(since);
  return Number.isFinite(started) ? formatDuration(now - started) : "时间未知";
}

export function TeamAttentionBar({
  waiting,
  workers,
  delegatingIds,
  onOpenWorker,
  onAskLead,
}: {
  waiting: Waiting[];
  workers: TaskListItem[];
  delegatingIds: ReadonlySet<string>;
  onOpenWorker: (taskId: string) => void;
  onAskLead: (worker: TaskListItem) => void | Promise<void>;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!waiting.length) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waiting.length]);

  if (!waiting.length) return null;
  return (
    <section className="team-attention" aria-label={`${waiting.length} 个执行者正在等待答复`}>
      <header>
        <ChatCircleDots size={15} weight="fill" aria-hidden="true" />
        <b>{waiting.length} 个执行者在等答复</b>
        <span>回答后对应执行者才会继续</span>
      </header>
      <div className="team-attention-list">
        {waiting.map(({ task, since }) => {
          const number = workers.findIndex((worker) => worker.id === task.id) + 1;
          const delegating = delegatingIds.has(task.id);
          return (
            <article key={task.id}>
              <div className="team-attention-question">
                <button type="button" onClick={() => onOpenWorker(task.id)}>{number ? `${number} ` : ""}{task.title}</button>
                <small>已等 {waitingDuration(since, now)}</small>
                <p>{task.question}</p>
              </div>
              <div className="team-question-actions">
                <button
                  className="team-question-delegate"
                  type="button"
                  disabled={delegating}
                  title="把问题转给调度者，让它调查后答复"
                  onClick={() => void onAskLead(task)}
                >
                  {delegating && <SpinnerGap size={11} className="is-spinning" />}
                  {delegating ? "转交中…" : "让调度者答"}
                </button>
                <button className="team-feed-answer" type="button" onClick={() => onOpenWorker(task.id)}>我来答</button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
