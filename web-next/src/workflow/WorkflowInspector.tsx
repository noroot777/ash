// Inspector 里的「工作流」页签：编排时画的那条线，执行时原样亮起来，只是转了 90°。
//
// 为什么竖着走：详情页正中间是会话，横条压在它头上滚两屏就看不见了；Inspector 是常驻
// 的窄栏，竖过来**每一站有一整行的宽度**——参数摘要、这一关的去向、没过时为什么没过，
// 都写得下。最要紧的是轮到人工关口时，「通过 / 打回」直接长在那一站底下。
//
// 两条口径不许在这儿另开一份：
// ① 每站底下那行字来自 railStops()，也就是任务列表里那一格的同一个词；
// ② 走到哪一站是从任务真实的 status/stage 反推的（resolveCursor），不是假进度条。
//    第二期执行链接管落了真游标之后，这个文件一行都不用改。
import type { Task } from "@harness/shared";
import { STEP_LABELS } from "@harness/shared/workflow";
import { ArrowUUpLeft, Check, Warning } from "@phosphor-icons/react";
import { AcceptanceControls } from "../team/TeamReviewWorkspace.tsx";
import { executorName, useExecutorCatalog, type ExecutorCatalog } from "./executorCatalog.ts";
import { stepChips } from "./stepFields.ts";
import { failText } from "./workflowEdit.ts";
import { railStops, workflowSummary, type RailStop } from "./workflowModel.ts";

/** 人工关口上那两个按钮是**真**验收/打回，所以只在任务确实停在那儿时才给。 */
function atHumanGate(task: Task): boolean {
  return task.stage === "awaiting_acceptance" || task.status === "awaiting_review";
}

function stateWord(stop: RailStop): string {
  if (stop.state === "done") return "已过";
  if (stop.state === "current") return stop.statusLabel;
  if (stop.state === "blocked") return "停在这儿";
  return "";
}

function Stop({
  stop, index, catalog, task, onTaskUpdated, notify,
}: {
  stop: RailStop;
  index: number;
  catalog: ExecutorCatalog;
  task: Task;
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const chips = stepChips(stop.step, (id) => executorName(catalog, id));
  const fail = failText(stop.step);
  const gate = stop.step.kind === "human" && stop.state !== "pending" && atHumanGate(task);

  return (
    <li className="wf-vst" data-state={stop.state}>
      <span className="wf-vpin" aria-hidden="true">
        {stop.state === "done"
          ? <Check size={9} weight="bold" />
          : stop.state === "blocked" ? <Warning size={9} weight="bold" /> : index + 1}
      </span>
      <div className="wf-vbody">
        <div className="wf-vhead">
          <b>{STEP_LABELS[stop.step.kind]}</b>
          <span className="wf-vword">{stateWord(stop)}</span>
        </div>
        {chips.length > 0 && (
          <div className="wf-vchips">
            {chips.map((chip) => (
              <em key={chip.key} data-warn={chip.warn}>{chip.text}</em>
            ))}
          </div>
        )}
        {fail && (
          <div className="wf-vfail">
            <ArrowUUpLeft size={10} aria-hidden="true" />没过就{fail}
          </div>
        )}
        {stop.state === "current" && stop.note && <p className="wf-vnote">{stop.note}</p>}
        {gate && (
          <div className="wf-vgate">
            <AcceptanceControls task={task} onTaskUpdated={onTaskUpdated} notify={notify} />
            <p className="wf-vnote">在这儿按，和在审查页里按是同一件事。</p>
          </div>
        )}
      </div>
    </li>
  );
}

export function WorkflowInspector({
  task, onTaskUpdated, notify,
}: {
  task: Task;
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const catalog = useExecutorCatalog();
  const def = task.workflow ?? null;

  if (!def) {
    return (
      <div className="task-inspector" aria-label="工作流">
        <div className="task-inspector-scroll">
          <section>
            <h2>这条线</h2>
            <p className="task-inspector-note">
              这个任务身上没有编排。它建于工作流之前，行为跟以前完全一样；
              之后新建的任务会在创建那一刻把线拷进自己兜里。
            </p>
          </section>
        </div>
      </div>
    );
  }

  const stops = railStops(def, task);

  return (
    <div className="task-inspector" aria-label="工作流">
      <div className="task-inspector-scroll">
        <section>
          <h2>这条线</h2>
          <div className="task-inspector-row">
            <span>顺序</span>
            <div>{workflowSummary(def)}</div>
          </div>
          <div className="task-inspector-row">
            <span>在哪儿干活</span>
            <div>{def.workspace === "isolated" ? "单独开一份工作区" : "直接在项目目录里"}</div>
          </div>
          <p className="task-inspector-note">
            这是任务创建那一刻拷下来的一份快照。之后在设置里改起手式，不会追着改它。
          </p>
        </section>

        <section>
          <h2>走到哪了</h2>
          <ol className="wf-vrail">
            {stops.map((stop, index) => (
              <Stop
                key={stop.step.id}
                stop={stop}
                index={index}
                catalog={catalog}
                task={task}
                onTaskUpdated={onTaskUpdated}
                notify={notify}
              />
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
