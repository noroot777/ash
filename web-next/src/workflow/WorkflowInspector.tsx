// Inspector 里的「工作流」页签：编排时画的那条线，执行时原样亮起来，只是转了 90°。
//
// 为什么竖着走：详情页正中间是会话，横条压在它头上滚两屏就看不见了；Inspector 是常驻
// 的窄栏，竖过来**每一站有一整行的宽度**——参数摘要、这一关的去向、没过时为什么没过，
// 都写得下。最要紧的是轮到人工关口时，「通过 / 打回」直接长在那一站底下。
//
// 两条口径不许在这儿另开一份：
// ① 每站底下那行字来自 railStops()，也就是任务列表里那一格的同一个词；
// ② 走到哪一站读的是任务身上那个真游标（resolveCursor），不是假进度条，也不是从
//    stage 猜的——尤其是人工关口那两个真按钮，判据只能是「游标停在这一道上」。
import type { Task } from "@harness/shared";
import type { WorkflowDef } from "@harness/shared/workflow";
import { STEP_LABELS, WORKSPACE_LABELS } from "@harness/shared/workflow";
import { ArrowUUpLeft, Check, Warning } from "@phosphor-icons/react";
import { AcceptanceControls } from "../team/TeamReviewWorkspace.tsx";
import { executorName, useExecutorCatalog, type ExecutorCatalog } from "./executorCatalog.ts";
import { PreviewRestartButton } from "./PreviewRestartButton.tsx";
import { stepChips } from "./stepFields.ts";
import { VerifyGateControls } from "./VerifyGateControls.tsx";
import { failText } from "./workflowEdit.ts";
import { railStops, workflowSummary, isCursorStop, verifyStationAtCursor, type RailStop } from "./workflowModel.ts";

/**
 * 人工关口上那两个按钮是**真**验收/打回，所以只在**线确实停在这一道关口**时才给。
 *
 * 判据是游标（isCursorStop），不是 stage：`awaiting_acceptance` 只说明「有人把这个任务
 * 标成了待验收」，可能是 agent 按完成协议自报的，也可能属于线上另一道关口——照它给
 * 按钮，用户就会在一道还没轮到的关口上按下不可逆的验收。任务状态仍要一起满足，免得
 * 游标刚落到这一站、关口还没真正停下就先把按钮亮出来。
 */
function atHumanGate(task: Task, stop: RailStop): boolean {
  if (stop.step.kind !== "human" || !isCursorStop(stop)) return false;
  return task.stage === "awaiting_acceptance" || task.status === "awaiting_review";
}

/**
 * 验证站上那两个按钮（再验一轮 / 人工强制通过）的判据在 `verifyStationAtCursor` 单点，
 * 这里只把算好的站 id 传下去。两处刻意不同：
 *
 * ① 人工关口那两个按钮要 stage/status 一起确认「关口真停下了」，因为线刚走到关口那一
 *    瞬间按下去是笔不可逆的账；
 * ② 验证站相反——它卡住的三种方式里有一种是**验证器压根没上报**，那时 stage 停在
 *    verifying、跟「正在验」长得一模一样，再叠 stage 条件，最该给出路的那一种反而没有
 *    按钮。真在跑的那一轮由按钮自己按 status 灰掉（后端同样会 409），不靠这里拦。
 */
function stateWord(stop: RailStop): string {
  if (stop.state === "done") return "已过";
  if (stop.state === "current") return stop.statusLabel;
  if (stop.state === "blocked") return "停在这儿";
  return "";
}

function Stop({
  stop, index, catalog, def, verifyStationId, task, onTaskUpdated, notify,
}: {
  stop: RailStop;
  index: number;
  catalog: ExecutorCatalog;
  def: WorkflowDef;
  verifyStationId: string | null;
  task: Task;
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const chips = stepChips(stop.step, (id) => executorName(catalog, id));
  const fail = failText(stop.step);
  const gate = atHumanGate(task, stop);
  const verify = verifyStationId === stop.step.id;

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
        {verify && (
          <div className="wf-vgate">
            <VerifyGateControls
              task={task}
              def={def}
              stationId={stop.step.id}
              onTaskUpdated={onTaskUpdated}
              notify={notify}
            />
          </div>
        )}
        {/* 走过的预览站底下常驻一颗手动开关：预览会在任务一开跑时被收掉，而把它起回来
            的自动路径只有一条（agent 确认完成 → 线往前走到这一站），问一句就没了。
            还没走到的站（pending）不给——那会儿起的是上一版代码。 */}
        {stop.step.kind === "preview" && stop.state !== "pending" && (
          <div className="wf-vgate">
            <PreviewRestartButton task={task} step={stop.step} notify={notify} />
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
  const verifyStationId = verifyStationAtCursor(task)?.stationId ?? null;

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
            <div>{WORKSPACE_LABELS[def.workspace]}</div>
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
                def={def}
                verifyStationId={verifyStationId}
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
