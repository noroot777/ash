import { createContext, useContext } from "react";
import type { TaskListItem } from "@navi/shared";
import type { LookForTask } from "../lib/useTaskReadState.ts";
import { dispatchTally, type DispatchFacts } from "../lib/dispatchTree.ts";
import type { BelowSignal } from "../lib/taskLook.ts";
import { DispatchGlyph, dispatchGlyphSaid } from "../components/DispatchGlyph.tsx";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { dispatchPath } from "../lib/dispatchFamily.ts";
import { forestRoot, type DispatchForest } from "./dispatchForest.ts";
import { TaskRow } from "./TaskTreeRows.tsx";

const NO_FACTS: DispatchFacts = { count: () => 0, needsYou: () => false, hasBelow: () => false };
const DispatchFactsContext = createContext<DispatchFacts>(NO_FACTS);
export const DispatchFactsProvider = DispatchFactsContext.Provider;
export const useDispatchFacts = () => useContext(DispatchFactsContext);

// 行尾那个数前面带「子任务」那颗图标（竖轨那一格、任务头同一颗）：光秃秃一个数挨着状态短语，
// 「运行中 13」读出来是「13 条在运行」，其实是「它在运行、名下 13 条子任务」。名下此刻怎么样不写字，
// 只给这颗图标上色（见 DispatchGlyph），指上去说是哪一条、在等什么。
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
  const count = dispatchTally(facts, task.id);
  const selected = allTasks.find((item) => item.id === selectedTaskId);
  const containsSelection = selected && dispatchPath(selected, allTasks).some((item) => forestRoot(forest, item.id) === task.id);
  return <TaskRow {...props} task={task} allTasks={allTasks}
    selectedTaskId={containsSelection ? task.id : selectedTaskId}
    tally={count == null ? undefined : <DispatchCount count={count} below={props.lookForTask(task).below} />}
  />;
}

function DispatchCount({ count, below }: { count: number; below: BelowSignal | null }) {
  const tip = useHoverTip();
  const said = dispatchGlyphSaid(count, below);
  return <>
    <span className="workspace-dispatch-count" aria-label={said} {...tip.anchorProps}><DispatchGlyph below={below} />{count}</span>
    <HoverTip at={tip.at}>{below?.tip ?? said}</HoverTip>
  </>;
}
