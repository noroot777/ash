import { createContext, useContext } from "react";
import type { TaskListItem } from "@ash/shared";
import type { LookForTask } from "../lib/useTaskReadState.ts";
import { dispatchTally, dispatchTallySaid, type DispatchFacts } from "../lib/dispatchTree.ts";
import { dispatchPath } from "../lib/dispatchFamily.ts";
import { forestRoot, type DispatchForest } from "./dispatchForest.ts";
import { TaskRow } from "./TaskTreeRows.tsx";

const NO_FACTS: DispatchFacts = { count: () => 0, needsYou: () => false, hasBelow: () => false };
const DispatchFactsContext = createContext<DispatchFacts>(NO_FACTS);
export const DispatchFactsProvider = DispatchFactsContext.Provider;
export const useDispatchFacts = () => useContext(DispatchFactsContext);

export function DispatchAwareRow({ task, forest, allTasks, selectedTaskId, ...props }: {
  task: TaskListItem;
  forest: DispatchForest;
  allTasks: TaskListItem[];
  selectedTaskId: string | null;
  onTask: (task: TaskListItem) => void;
  lookForTask: LookForTask;
  showProject?: boolean;
}) {
  const facts = useDispatchFacts();
  const tally = dispatchTally(facts, task.id);
  const selected = allTasks.find((item) => item.id === selectedTaskId);
  const containsSelection = selected && dispatchPath(selected, allTasks).some((item) => forestRoot(forest, item.id) === task.id);
  return <TaskRow {...props} task={task} allTasks={allTasks}
    selectedTaskId={containsSelection ? task.id : selectedTaskId} phrase={!!tally}
    tally={tally && <span className={`workspace-dispatch-count${tally.warn ? " is-warn" : ""}`} aria-label={dispatchTallySaid(tally)}>{tally.count}</span>}
  />;
}
