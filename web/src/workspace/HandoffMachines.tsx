import { useCallback, useEffect, useMemo, useState } from "react";
import type { HandoffTarget, ProjectView, TaskListItem } from "@ash/shared";
import { CaretRight, DesktopTower, PaperPlaneTilt } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { BulkHandoffDialog } from "./BulkHandoffDialog.tsx";
import { outboundTasksForTarget } from "./bulkHandoff.ts";
import { useRevealHiddenSelection } from "./TaskTreeRows.tsx";

// 开合状态自己存一份，不跟任务分节共用 `ash:task-tree:collapsed-sections`：那份由
// TaskTree 里的 useCollapsedSections 持有，这一节在它外面，两个 hook 实例各写各的
// 同一个键，最后一个写的会把另一个的收起状态抹掉。
//
// 这一节排在任务后面、默认折成一行。键从旧的 `ash:handoff-machines:collapsed` 换成了
// 记「开着」的这一个：老用户本地存着的是「展开」（"0"），沿用旧键的话默认折起对他们
// 永远不生效。旧键不再读。
const OPEN_STORAGE_KEY = "ash:handoff-machines:open";

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_STORAGE_KEY) === "1";
  } catch {
    // 隐私模式下读不到 storage 也得能用，只是记不住。
    return false;
  }
}

export function HandoffMachines({
  project,
  tasks,
  selectedRemoteTaskId,
  onRemoteTask,
  notify,
  onFinished,
}: {
  project: ProjectView | null;
  tasks: TaskListItem[];
  selectedRemoteTaskId: string | null;
  onRemoteTask: (task: TaskListItem, target: HandoffTarget) => void;
  notify: (message: string) => void;
  onFinished: () => Promise<void> | void;
}) {
  const [targets, setTargets] = useState<HandoffTarget[]>([]);
  const [selected, setSelected] = useState<HandoffTarget | null>(null);
  const [open, setOpen] = useState(readOpen);
  useEffect(() => {
    try {
      window.localStorage.setItem(OPEN_STORAGE_KEY, open ? "1" : "0");
    } catch {
      // 存不下就只在这一次会话里生效。
    }
  }, [open]);

  const reloadTargets = useCallback(() => {
    let alive = true;
    // 走 `/handoff/targets` 而不是 `GET /settings` 里那份:多人模式下目标机按人存,
    // app_settings 那份是自用模式的公共清单(多人实例里通常是空的)。
    api.handoffTargets()
      .then((rows) => { if (alive) setTargets(rows); })
      .catch((reason) => { if (alive) notify(reason instanceof Error ? reason.message : "接力目标读取失败"); });
    return () => { alive = false; };
  }, [notify]);
  useEffect(() => reloadTargets(), [reloadTargets]);

  const outboundByTarget = useMemo(() => new Map(targets.map((target) => [
    target.url,
    project ? outboundTasksForTarget(tasks, project.id, target, targets) : [],
  ])), [project, targets, tasks]);

  // 选中的远端任务正好在这一节里时把它展开：主区已经在显示那条任务了，侧栏却一行都
  // 看不到，等于「我现在在哪」没有答案。只在**选中变化**那一下展开（跟任务树同一套
  // 判据），用户之后自己再收起来不会被反复顶开。
  const holdsSelection = !!selectedRemoteTaskId
    && [...outboundByTarget.values()].some((rows) => rows.some((task) => task.id === selectedRemoteTaskId));
  useRevealHiddenSelection(
    holdsSelection ? selectedRemoteTaskId : null,
    useCallback(() => setOpen(true), []),
  );
  const count = useMemo(() => [...outboundByTarget.values()].reduce((sum, rows) => sum + rows.length, 0), [outboundByTarget]);

  if (!targets.length || !project) return null;

  return (
    <section className={`workspace-handoff-machines${open ? "" : " is-collapsed"}`} aria-labelledby="workspace-handoff-machines-title">
      {/* 折起来就是一行：名字、指上去才出的箭头、右边写着接力出去了几条。点开和从前一样：
          一台机器一行，接力过去的任务缩进在它下面。 */}
      <button
        className="workspace-fold"
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "折叠" : "展开"}其他机器，${count} 条`}
        onClick={() => setOpen((value) => !value)}
      >
        <span id="workspace-handoff-machines-title">其他机器</span>
        <CaretRight size={12} weight="bold" aria-hidden="true" />
        <b>{count}</b>
      </button>
      {open && <div className="workspace-handoff-machine-list">
        {targets.map((target) => {
          const outbound = outboundByTarget.get(target.url) ?? [];
          return (
            <div className="workspace-handoff-machine-group" key={target.url}>
              <div className="workspace-handoff-machine">
                <DesktopTower size={14} aria-hidden="true" />
                <span className="workspace-handoff-machine-copy">
                  <b>{target.name}</b>
                </span>
                <button
                  type="button"
                  aria-label={`把本项目正在跑的任务接力到 ${target.name}`}
                  onClick={() => setSelected(target)}
                >
                  <PaperPlaneTilt size={13} weight="bold" aria-hidden="true" />
                </button>
              </div>
              {outbound.length > 0 && (
                <div className="workspace-handoff-task-list" aria-label={`${target.name}上的接力任务`}>
                  {outbound.map((task) => (
                    <button
                      className={`workspace-handoff-task${selectedRemoteTaskId === task.id ? " is-selected" : ""}`}
                      type="button"
                      aria-current={selectedRemoteTaskId === task.id ? "page" : undefined}
                      /* J/K 按屏幕上那份列表走（见 sidebarNavigation）：这一节里的行也是人眼
                         看得见的行，挂上同一个身份标记就自动进了那份顺序，不必单开一套。 */
                      data-task-id={task.id}
                      onClick={() => onRemoteTask(task, target)}
                      key={task.id}
                    >
                      <i aria-hidden="true" />
                      <span>{task.title || "未命名任务"}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>}
      {selected && (
        <BulkHandoffDialog
          project={project}
          target={selected}
          tasks={tasks}
          notify={notify}
          onClose={() => { setSelected(null); reloadTargets(); }}
          onFinished={onFinished}
        />
      )}
    </section>
  );
}
