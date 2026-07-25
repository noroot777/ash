import type { Task, TaskStatus } from "@harness/shared";
import { isUserSettableStatus, canArchive } from "@harness/shared";
import { STATUSES } from "./constants";
import { PriorityIcon, PauseHint } from "./ui";
import { StatusIcon } from "./StatusIcon";
import { foldTeamStatus, pairBadge } from "./util";
import { workersOf } from "./team/teamData";

// paused/idle 不单独成列 —— 它们视觉上都属于"进行中"的一种（跑到检查点等续跑 /
// 指挥台在线但这一刻没在说话），跟 running 同住一列；卡片本身用 StatusIcon 区分。
const IN_RUNNING: TaskStatus[] = ["running", "paused", "idle"];

// Kanban board: one column per status, drag a card across columns to change its
// status. Clicking a card opens it (switches back to list+detail).
// 团队任务只上一张卡（指挥台那张）；它的工人（parentId 非空）不上板 —— 一次派 6 个
// 工人会把板冲垮，工人在团队视图/列表展开里看。
export function Board({
  tasks,
  onMove,
  onOpen,
}: {
  tasks: Task[];
  onMove: (id: string, status: TaskStatus) => void;
  onOpen: (id: string) => void;
}) {
  const columns = STATUSES.filter((s) => s.key === "running" || !IN_RUNNING.includes(s.key));
  const onBoard = tasks.filter((t) => !t.parentId);
  return (
    <div className="flex h-full gap-3 overflow-x-auto px-4 py-4">
      {columns.map((s) => {
        const col = onBoard.filter((t) =>
          s.key === "running" ? IN_RUNNING.includes(t.status) : t.status === s.key,
        );
        // running/queued/awaiting_review are system-owned — you can't drop a card
        // into them by hand (that would fake an execution state).
        const droppable = isUserSettableStatus(s.key);
        return (
          <div
            key={s.key}
            className={`flex w-72 shrink-0 flex-col rounded-lg border border-line bg-panel ${droppable ? "" : "opacity-75"}`}
            onDragOver={(e) => droppable && e.preventDefault()}
            onDrop={(e) => {
              if (!droppable) return;
              const id = e.dataTransfer.getData("text/plain");
              if (id) onMove(id, s.key);
            }}
          >
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <StatusIcon status={s.key} size={13} />
              <span className="text-[12px] font-semibold text-ink">{s.label}</span>
              <span className="font-mono text-[11px] text-faint">{col.length}</span>
              {!droppable && <span className="ml-auto text-[10px] text-faint">系统态</span>}
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {col.map((t) => (
                <div
                  key={t.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)}
                  onClick={() => onOpen(t.id)}
                  className="rise cursor-pointer rounded-md border border-line bg-raised/50 p-2.5 transition-colors hover:border-line2"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5">
                      <PriorityIcon p={t.priority} />
                    </span>
                    {/* running 列里混住 running/paused/idle，卡片自己把状态画出来 */}
                    <CardStatus t={t} allTasks={tasks} />
                    <span className="text-sm leading-snug text-ink">{t.title}</span>
                  </div>
                  <PauseHint task={t} allTasks={tasks} onOpen={onOpen} />
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {t.queueId != null && !canArchive(t.status) && (
                      <span
                        className="rounded bg-overlay px-1.5 py-0.5 font-mono text-[10px] text-muted"
                        title="在某个队列里的位置(详情页可以点开看完整队列)"
                      >
                        ↳ #{(t.queuePosition ?? 0) + 1}
                      </span>
                    )}
                    {t.labels.map((l) => (
                      <span key={l} className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                        {l}
                      </span>
                    ))}
                    <span className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[10px] ${pairBadge(t).cls}`}>
                      {pairBadge(t).label}
                    </span>
                  </div>
                </div>
              ))}
              {col.length === 0 && <div className="py-6 text-center text-[11px] text-faint">—</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// 卡片左上角那个状态点。纯 running 不用画（列头已经说了），paused/idle 得画，因为它们
// 跟 running 挤在同一列里。团队卡画的是**折叠**状态：指挥台待命着、但某个工人卡在提问
// 上时，这张卡要亮青色问号，别让它看着像没事。
function CardStatus({ t, allTasks }: { t: Task; allTasks: Task[] }) {
  if (t.mode === "team") {
    const fold = foldTeamStatus(t, workersOf(allTasks, t.id));
    return (
      <span className="mt-0.5">
        <StatusIcon status={fold.status} size={13} awaitingAnswer={fold.awaitingAnswer} />
      </span>
    );
  }
  if (t.status !== "paused" && t.status !== "idle") return null;
  return (
    <span className="mt-0.5">
      <StatusIcon status={t.status} size={13} />
    </span>
  );
}
