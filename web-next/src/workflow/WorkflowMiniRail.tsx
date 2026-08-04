// 收起态的线：一排站名胶囊，中间是常驻的虚线 ＋。
//
// 它要挤进新建任务面板里一行的高度，所以**只剩站名**——参数、任务显示什么状态、失败
// 往哪拐，全在展开态（WorkflowRail）里。同一份定义、同一套改法，只是两个尺寸。
import { Fragment, useRef, useState } from "react";
import type { WorkflowDef } from "@harness/shared/workflow";
import { STEP_KINDS, STEP_LABELS } from "@harness/shared/workflow";
import { Plus } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { canAddStep, insertStep, removeStep } from "./workflowEdit.ts";

function AddHere({ def, at, onChange }: { def: WorkflowDef; at: number; onChange: (def: WorkflowDef) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useDismissable({ enabled: open, containerRef: box, onClose: () => setOpen(false) });
  if (!canAddStep(def)) return <i className="wf-mini-gap" aria-hidden="true" />;
  return (
    <span className="wf-mini-slot" ref={box}>
      <button
        type="button"
        className="wf-mini-add"
        aria-label={`在第 ${at + 1} 站前面加一站`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Plus size={9} weight="bold" aria-hidden="true" />
      </button>
      {open && (
        <div className="wf-pop wf-pop-up" role="dialog" aria-label="加一站">
          <div className="wf-pop-options">
            {STEP_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className="wf-pop-option"
                onClick={() => { onChange(insertStep(def, at, kind)); setOpen(false); }}
              >
                {STEP_LABELS[kind]}
              </button>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}

export function WorkflowMiniRail({
  def, onChange,
}: {
  def: WorkflowDef;
  onChange?: (def: WorkflowDef) => void;
}) {
  return (
    <div className="wf-mini">
      {onChange && <AddHere def={def} at={0} onChange={onChange} />}
      {def.steps.map((step, i) => (
        <Fragment key={step.id}>
          <span className="wf-mini-stop">
            {STEP_LABELS[step.kind]}
            {onChange && def.steps.length > 1 && (
              <button
                type="button"
                className="wf-mini-del"
                aria-label={`拆掉「${STEP_LABELS[step.kind]}」这一站`}
                onClick={() => onChange(removeStep(def, step.id))}
              >
                ✕
              </button>
            )}
          </span>
          {onChange
            ? <AddHere def={def} at={i + 1} onChange={onChange} />
            : i < def.steps.length - 1 && <i className="wf-mini-gap" aria-hidden="true" />}
        </Fragment>
      ))}
    </div>
  );
}
