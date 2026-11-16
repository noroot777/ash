import { useEffect, useMemo, useState } from "react";
import type { Task, TaskListItem } from "@ash/shared";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { dispatchFamily, dispatchBranchAccepted, dispatchLevel, createDispatchView } from "../../lib/dispatchFamily.ts";
import { dispatchHolderOf, dispatchHoldPhrase, dispatchedLive } from "../../lib/dispatchHold.ts";
import { dispatchedOf, dispatchFacts, dispatchTally, dispatchTallySaid } from "../../lib/dispatchTree.ts";
import { InspectorHeadActions } from "../../inspector/index.ts";
import type { Notify } from "../../lib/notify.ts";
import { dispatchedMeta, dispatchedOrder, dispatchedWord } from "./dispatchedRows.ts";
import { DispatchHoldKey } from "./DispatchHoldKey.tsx";
import { readDispatchFolds, writeDispatchFolds } from "./dispatchFolds.ts";

export function DispatchedInspector({ task, allTasks, onOpenTask, onTaskUpdated, notify }: {
  task: TaskListItem;
  allTasks: readonly TaskListItem[];
  onOpenTask: (taskId: string) => void;
  onTaskUpdated: (task: Task) => void;
  notify: Notify;
}) {
  const family = useMemo(() => dispatchFamily(task, allTasks), [task, allTasks]);
  return <FamilyTable key={family.root.id} {...{ task, allTasks, onOpenTask, onTaskUpdated, notify }} family={family} />;
}

function FamilyTable({ task, allTasks, onOpenTask, onTaskUpdated, notify, family }: Parameters<typeof DispatchedInspector>[0] & {
  family: ReturnType<typeof dispatchFamily>;
}) {
  const { root, children } = family;
  const direct = dispatchedOf(allTasks, root.id);
  const [folds, setFolds] = useState(() => readDispatchFolds(root.id, children, task.id));
  const [hint, setHint] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => writeDispatchFolds(root.id, folds, task.id), [folds, root.id, task.id]);
  const ticking = allTasks.some((item) => item.startedAt && !item.endedAt);
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const facts = useMemo(() => dispatchFacts(allTasks), [allTasks]);
  const dispatchView = useMemo(() => createDispatchView(allTasks), [allTasks]);
  const holder = dispatchHolderOf(task.id, new Map(allTasks.map((item) => [item.id, item])));
  const toggle = (id: string, open: boolean) => setFolds((current) => {
    const next = new Map(current).set(id, !open);
    return next;
  });
  const mark = (item: TaskListItem) => {
    const look = dispatchView.look(item);
    return look.mark ? <i className={`workspace-status-dot workspace-status-dot--${look.mark}`} aria-hidden="true" /> : null;
  };
  const row = (item: TaskListItem, seen: ReadonlySet<string>) => {
    const accepted = dispatchBranchAccepted(item, children);
    const level = dispatchLevel(children, item.id, task.id);
    const open = (hint && dispatchLevel(children, item.id, hint).containsSelection) || (folds.get(item.id) ?? level.branchOpen);
    const tally = dispatchTally(facts, item.id);
    const { word, tone } = dispatchedWord(item, dispatchView.look(item));
    const meta = !accepted ? dispatchedMeta(item, now) : "";
    return <li key={item.id}>
      <div data-subtask-id={item.id} className={`dispatched-row${task.id === item.id ? " is-current" : ""}${hint === item.id ? " is-hinted" : ""}${accepted ? " is-settled" : ""}`}>
        <span className="dispatched-row__mark">{!accepted && mark(item)}</span>
        <span className="dispatched-row__main">
          <span className="dispatched-row__top">
            <button type="button" className="dispatched-row__title" aria-current={task.id === item.id ? "page" : undefined} onClick={() => onOpenTask(item.id)}>{item.title || "未命名任务"}</button>
            {tally && <button type="button" className={`dispatched-fold${tally.warn ? " is-warn" : ""}`} aria-label={dispatchTallySaid(tally)} aria-expanded={open} onClick={() => toggle(item.id, open)}>{tally.count}<CaretDown size={10} aria-hidden="true" /></button>}
          </span>
          {meta && <small className={item.question ? undefined : "is-mono"}>{meta}</small>}
        </span>
        {!accepted && <em className={tone ? `is-${tone}` : undefined}>{word}</em>}
      </div>
      {open && (children.get(item.id)?.length ?? 0) > 0 && list(item.id, seen)}
    </li>;
  };
  const list = (parentId: string, seen: ReadonlySet<string>) => {
    if (seen.has(parentId)) return null;
    const next = new Set(seen).add(parentId);
    const level = dispatchLevel(children, parentId, task.id);
    const open = (hint && dispatchLevel(children, parentId, hint).selectedInAccepted) || (folds.get(`accepted:${parentId}`) ?? level.acceptedOpen);
    return <ul className="dispatched-list">
      {level.accepted.length > 0 && <li><button type="button" className="dispatched-accepted" aria-expanded={open} onClick={() => toggle(`accepted:${parentId}`, open)}><CaretRight size={10} aria-hidden="true" />{level.accepted.length} 条已验收</button></li>}
      {open && level.accepted.map((item) => row(item, next))}
      {level.rest.map((item) => row(item, next))}
    </ul>;
  };
  const finished = direct.filter((item) => item.status === "done" || dispatchBranchAccepted(item, children)).length;
  const summary = [`${finished}/${direct.length}`, dispatchedOrder(direct)].filter(Boolean).join(" · ");
  return <div className={`dispatched-pane${root.dispatchHoldAt ? " is-held" : ""}`}>
    <InspectorHeadActions><small className="dispatched-summary">{summary}</small></InspectorHeadActions>
    {!holder && <DispatchHoldKey task={root} live={dispatchedLive(allTasks, root.id)} onTaskUpdated={onTaskUpdated} notify={notify} />}
    {(holder || root.dispatchHoldAt) && <p className="dispatched-head">{holder
      ? <button type="button" className="dispatched-head__holder" onClick={() => onOpenTask(holder.id)}>{dispatchHoldPhrase(holder)}</button>
      : root.dispatchHoldPendingAt ? "正在停下" : "已全部停下"}</p>}
    <div className="dispatched-pips" aria-label="直接子任务">{direct.map((item) => <button type="button" key={item.id} aria-label={item.title || "未命名任务"} onClick={() => onOpenTask(item.id)} onMouseEnter={() => setHint(item.id)} onMouseLeave={() => setHint(null)} onFocus={() => setHint(item.id)} onBlur={() => setHint(null)}>{mark(item) ?? <i className="dispatched-pip--quiet" />}</button>)}</div>
    <div aria-label="子任务">{list(root.id, new Set())}</div>
    {!(children.get(root.id)?.length) && <p className="dispatched-head">还没有子任务</p>}
  </div>;
}
