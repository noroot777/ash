// 「信息」格里的前置：一行「前置」列出它建在哪几条上、各自到哪一步了；一行「下游」列出建在它上面的。
// 点名字打开那条任务。只有要你动手的那几步上色。
//
// 还没开工的任务能在这里加减前置（能不能、候选能不能选，全听服务端：lib/prerequisiteOptions.ts 文件头）：
// 「前置」那一组下面一颗「建在某任务上面…」，选一条加一条；每一行指到时出一颗叉，去掉那一条。开工之后两样都不出。
// 「还没问到」「问失败了」「服务端说不能改」是三件事：问失败了不能当成不能改把入口藏掉，那一格写明读不到、给一颗重试。
// 加减之后服务端重发这条任务的快照（prerequisite-view.ts），这几行、会话里「在等谁」、侧栏都跟着换。
// 「下游」只看不改：要改去下游那条任务里改。
import { useCallback, useEffect, useRef, useState } from "react";
import type { Group, Task } from "@navi/shared";
import type { PrerequisiteCandidates } from "@navi/shared/prerequisites";
import { prerequisiteNeedsUser, prerequisiteStepText } from "@navi/shared/prerequisites";
import { ArrowSquareOut, X } from "@phosphor-icons/react";
import { Dropdown } from "../../components/Dropdown.tsx";
import { InspRow } from "../../inspector/parts.tsx";
import { api } from "../../lib/api.ts";
import { prerequisiteOptions } from "../../lib/prerequisiteOptions.ts";

export function InfoPrerequisites({ task, groups, readOnly, onOpenTask, onTasksSynced, notify }: {
  task: Task;
  groups: Group[];
  /** 不让改的任务（已归档）。能不能有前置另由服务端判：普通任务名下的子任务能有，团队执行者不能。 */
  readOnly: boolean;
  onOpenTask: (taskId: string) => void;
  onTasksSynced: (tasks: Task[]) => void;
  notify: (message: string) => void;
}) {
  const view = task.prerequisites;
  // 开工判据的头一条就是「还在待办上」（server/src/prerequisite-store.ts `hasLaunched`）：不在待办上的不必去问。
  const askable = !readOnly && task.status === "backlog";
  const signature = view?.prerequisites.map((item) => item.taskId).join(",") ?? "";
  const [edit, setEdit] = useState<{ taskId: string; result: PrerequisiteCandidates } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  const load = useCallback(() => {
    const seq = ++latest.current;
    if (!askable) { setEdit(null); return; }
    // 失败的那句留到重问成功才撤：重试那一下不闪掉。
    api.prerequisiteCandidates(task.projectId, { taskId: task.id }).then((result) => {
      if (seq !== latest.current) return;
      setEdit({ taskId: task.id, result });
      setFailed(false);
    }).catch(() => { if (seq === latest.current) setFailed(true); });
    // 前置那几条变了（signature）要重问：已经是前置的、会成环的跟着变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askable, task.id, task.projectId, signature]);
  useEffect(load, [load]);
  useEffect(() => setFailed(false), [task.id]);

  const current = edit?.taskId === task.id ? edit.result : null;
  const addable = askable && !!current && !current.locked;
  const removable = askable && !!current?.removable;
  const unread = askable && !current && failed;

  const change = async (run: () => Promise<Task>, done: string) => {
    setBusy(true);
    try {
      onTasksSynced([await run()]);
      notify(done);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      load();
    }
  };
  const add = (prerequisiteId: string) => {
    const title = current?.candidates.find((item) => item.taskId === prerequisiteId)?.title ?? "所选任务";
    void change(() => api.addPrerequisite(task.id, prerequisiteId), `已建在「${title}」上面`);
  };
  const remove = (prerequisiteId: string, title: string) =>
    void change(() => api.removePrerequisite(task.id, prerequisiteId), `已去掉前置「${title}」`);

  if (!view && !addable && !unread) return null;
  const link = (taskId: string, title: string) => (
    <button type="button" className="insp-val" aria-label={`打开「${title}」`} onClick={() => onOpenTask(taskId)}>
      <span className="insp-cut">{title}</span>
      <ArrowSquareOut size={12} aria-hidden="true" />
    </button>
  );
  const prerequisites = view?.prerequisites ?? [];
  return (
    <>
      {prerequisites.map((item, index) => (
        <InspRow key={item.taskId} label={index === 0 ? "前置" : ""}>
          {link(item.taskId, item.title)}
          <span className={`insp-cut ${prerequisiteNeedsUser(item.step) ? "insp-attn" : "insp-faint"}`}>{prerequisiteStepText(item)}</span>
          {removable && (
            <button type="button" className="insp-prereq-remove" aria-label={`去掉前置：${item.title}`} disabled={busy}
              onClick={() => remove(item.taskId, item.title)}><X size={12} /></button>
          )}
        </InspRow>
      ))}
      {unread && (
        <InspRow label={prerequisites.length ? "" : "前置"}>
          <span className="insp-cut insp-attn">读不到能不能改前置</span>
          <button type="button" className="insp-val is-end" onClick={load}>重试</button>
        </InspRow>
      )}
      {addable && (
        <InspRow label={prerequisites.length ? "" : "前置"}>
          <Dropdown
            className="insp-dropdown task-inspector-prerequisite-add"
            label="建在某任务上面"
            value=""
            placeholder="建在某任务上面…"
            filterPlaceholder="筛选任务…"
            disabled={busy}
            status={failed ? "failed" : "ready"}
            options={prerequisiteOptions(current?.candidates ?? [], groups)}
            onOpen={load}
            onChange={add}
          />
        </InspRow>
      )}
      {view?.dependents.map((item, index) => (
        <InspRow key={item.taskId} label={index === 0 ? "下游" : ""}>{link(item.taskId, item.title)}</InspRow>
      ))}
    </>
  );
}
