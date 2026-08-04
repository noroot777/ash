// 点一站弹出的菜单：这一站是什么、参数各是什么、往前往后挪、拆掉。
//
// 收起态那排胶囊上**不再挂 ✕**：一排小叉子既吵，又只给得起「删」这一个动作。改成
// 「点这一站 → 一张菜单里把这一站的事都办了」，和展开态「点哪儿改哪儿」是同一套心智，
// 只是收起时先经过一层目录。
//
// 参数编辑器与展开态共用 StepEditors 那一份 —— 两处各写一份，迟早出现「这儿能改那儿
// 不能改」。
import { useState } from "react";
import type { WorkflowDef, WorkflowStep } from "@harness/shared/workflow";
import { STEP_LABELS, hasFailBranch } from "@harness/shared/workflow";
import { executorName, type ExecutorCatalog } from "./executorCatalog.ts";
import { ExecutorEditor, FailEditor, MultiEditor, SelectEditor, TextEditor } from "./StepEditors.tsx";
import { STEP_FIELDS, fieldChip, type FieldSpec } from "./stepFields.ts";
import { stepStatusLabel } from "./workflowModel.ts";
import { failText, moveStep, patchFail, patchParams, removeStep } from "./workflowEdit.ts";

/** 执行器、模型、强度是联动的一组，钻进哪一个都开同一个编辑器。 */
const EXECUTOR_FIELDS = new Set(["executor", "model", "effort"]);

export interface StepMenuView {
  /** 钻进了哪个参数；null = 停在这一站的目录页 */
  drill: string | null;
  /** 菜单标题（Popover 用它当 aria-label） */
  label: string;
  back: (() => void) | null;
}

/** 菜单标题与「返回」由外层的 Popover 画，所以内容和标题得一起算出来。 */
export function useStepMenu(step: WorkflowStep, index: number): StepMenuView & {
  setDrill: (key: string | null) => void;
} {
  const [drill, setDrill] = useState<string | null>(null);
  const spec = drill && drill !== "fail" ? STEP_FIELDS[step.kind].find((s) => s.key === drill) : undefined;
  const label = drill === "fail"
    ? "这一站没过，往哪走"
    : spec?.label ?? `第 ${index + 1} 站 · ${STEP_LABELS[step.kind]}`;
  return { drill, setDrill, label, back: drill ? () => setDrill(null) : null };
}

function FieldEditor({
  def, step, spec, catalog, onChange, onDone,
}: {
  def: WorkflowDef;
  step: WorkflowStep;
  spec: FieldSpec;
  catalog: ExecutorCatalog;
  onChange: (def: WorkflowDef) => void;
  onDone: () => void;
}) {
  const value = (step.p as Record<string, unknown>)[spec.key];
  if (EXECUTOR_FIELDS.has(spec.type)) {
    return (
      <ExecutorEditor
        step={step}
        catalog={catalog}
        onPatch={(patch) => onChange(patchParams(def, step.id, patch))}
      />
    );
  }
  if (spec.type === "select") {
    return (
      <SelectEditor
        spec={spec}
        value={typeof value === "string" ? value : ""}
        onPick={(next) => { onChange(patchParams(def, step.id, { [spec.key]: next })); onDone(); }}
      />
    );
  }
  if (spec.type === "multi") {
    return (
      <MultiEditor
        spec={spec}
        values={Array.isArray(value) ? (value as string[]) : []}
        onToggle={(next) => onChange(patchParams(def, step.id, { [spec.key]: next }))}
      />
    );
  }
  if (spec.type !== "text") return null;
  return (
    <TextEditor
      spec={spec}
      value={typeof value === "string" ? value : ""}
      onChange={(next) => onChange(patchParams(def, step.id, { [spec.key]: next.trim() || null }))}
    />
  );
}

export function StepMenuBody({
  def, step, index, catalog, view, setDrill, onChange, onClose,
}: {
  def: WorkflowDef;
  step: WorkflowStep;
  index: number;
  catalog: ExecutorCatalog;
  view: StepMenuView;
  setDrill: (key: string | null) => void;
  onChange: (def: WorkflowDef) => void;
  onClose: () => void;
}) {
  const spec = view.drill && view.drill !== "fail"
    ? STEP_FIELDS[step.kind].find((s) => s.key === view.drill)
    : undefined;

  if (view.drill === "fail" && step.fail) {
    return <FailEditor step={step} onPatch={(patch) => onChange(patchFail(def, step.id, patch))} />;
  }
  if (spec) {
    return (
      <FieldEditor
        def={def}
        step={step}
        spec={spec}
        catalog={catalog}
        onChange={onChange}
        onDone={() => setDrill(null)}
      />
    );
  }

  const fail = failText(step);
  return (
    <>
      <p className="wf-pop-hint wf-pop-lead">
        这一步跑的时候，任务显示「{stepStatusLabel(step.kind)}」。
      </p>
      <div className="wf-pop-options">
        {STEP_FIELDS[step.kind].map((row) => {
          const chip = fieldChip(step, row, (id) => executorName(catalog, id));
          return (
            <button
              key={row.key}
              type="button"
              className="wf-pop-cell"
              onClick={() => setDrill(row.key)}
            >
              {row.label}
              <b data-warn={chip?.warn ? "yes" : "no"}>{chip?.text ?? "跟随执行器"}</b>
            </button>
          );
        })}
        {fail && hasFailBranch(step.kind) && (
          <button type="button" className="wf-pop-cell" onClick={() => setDrill("fail")}>
            没过怎么办<b>{fail}</b>
          </button>
        )}
      </div>
      <div className="wf-pop-ops">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => onChange(moveStep(def, step.id, -1))}
        >
          ← 往前
        </button>
        <button
          type="button"
          disabled={index === def.steps.length - 1}
          onClick={() => onChange(moveStep(def, step.id, 1))}
        >
          往后 →
        </button>
        <button
          type="button"
          className="wf-pop-del"
          disabled={def.steps.length <= 1}
          onClick={() => { onChange(removeStep(def, step.id)); onClose(); }}
        >
          拆掉这一站
        </button>
      </div>
    </>
  );
}
