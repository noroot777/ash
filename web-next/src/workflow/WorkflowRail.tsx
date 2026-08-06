// 一条线的横版线路图：名牌一行、线上的站点一行、站台底下的参数与状态一行。
//
// 交互口径是「改哪儿点哪儿」——点参数就地换、点段中间的 ＋ 加一站、点失败标签改
// 去向，全程不用先选中再去别处的面板找。给了 onChange 才可编辑，不给就是只读展示
// （任务详情里看这条线长什么样）。给了 task 就按它此刻的真实状态把走到的那一站点亮。
import { Fragment, useRef, useState } from "react";
import type { Task } from "@harness/shared";
import type { StepKind, WorkflowDef, WorkflowIssue, WorkflowStep } from "@harness/shared/workflow";
import { STEP_KINDS, STEP_LABELS, hasFailBranch } from "@harness/shared/workflow";
import { ArrowUUpLeft, Plus } from "@phosphor-icons/react";
import { Popover } from "./Popover.tsx";
import { executorName, useExecutorCatalog, type ExecutorCatalog } from "./executorCatalog.ts";
import { ExecutorEditor, FailEditor, MultiEditor, SelectEditor, TextEditor } from "./StepEditors.tsx";
import { STEP_FIELDS, stepChips, type FieldSpec } from "./stepFields.ts";
import { STEP_SHORT, railStops } from "./workflowModel.ts";
import { canAddKind, canAddStep, failText, insertStep, moveStep, patchFail, patchParams, removeStep } from "./workflowEdit.ts";

/** 执行器、模型、强度是联动的一组，点哪颗都开同一个编辑器。 */
const EXECUTOR_FIELDS = new Set(["executor", "model", "effort"]);

/**
 * 站数到了这个数就整体紧一档（CSS 那边收下限与字号）。
 *
 * 6 是量出来的，不是拍的：起手式那一页主栏约 1100px，段列和站列按 0.22/1 分伸缩比，
 * 6 站正好把站列压到 116px 的下限；再多一站就得靠紧凑档才不出滚动条。内置起手式最长
 * 的一条是 5 站，所以常规情况下永远是宽松档，只有用户自己接长了才会紧。
 */
const DENSE_FROM = 6;

function fieldSpec(kind: StepKind, key: string): FieldSpec | undefined {
  return STEP_FIELDS[kind].find((spec) => spec.key === key);
}

/** 一颗可点的标签 + 它自己那张菜单。菜单挂在 body 上（见 Popover），不会被卡片裁掉。 */
function ChipSlot({
  className, label, text, disabled, open, onToggle, onClose, children,
}: {
  className: string;
  label: string;
  text: React.ReactNode;
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div className="wf-chip-slot">
      <button
        type="button"
        ref={anchor}
        className={className}
        disabled={disabled}
        aria-expanded={open}
        onClick={onToggle}
      >
        {text}
      </button>
      {open && (
        <Popover anchorRef={anchor} label={label} onClose={onClose}>{children}</Popover>
      )}
    </div>
  );
}

function StepBody({
  def, step, catalog, statusLabel, note, tone, onChange,
}: {
  def: WorkflowDef;
  step: WorkflowStep;
  catalog: ExecutorCatalog;
  statusLabel: string;
  note: string | null;
  tone: string;
  onChange?: (def: WorkflowDef) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const chips = stepChips(step, (id) => executorName(catalog, id));
  const fail = failText(step);
  const editable = !!onChange;
  const close = () => setOpen(null);

  const spec = open && open !== "fail" ? fieldSpec(step.kind, open) : undefined;
  const value = (step.p as Record<string, unknown>)[open ?? ""];

  return (
    <div className={`wf-body ${tone}`}>
      <div className="wf-status">
        任务显示 <b>{statusLabel}</b>{note && <em>· {note}</em>}
      </div>
      {chips.map((chip) => (
        <ChipSlot
          key={chip.key}
          className={`wf-chip${chip.warn ? " is-warn" : ""}`}
          label={fieldSpec(step.kind, chip.key)?.label ?? chip.key}
          text={chip.text}
          disabled={!editable}
          open={open === chip.key}
          onToggle={() => setOpen((current) => (current === chip.key ? null : chip.key))}
          onClose={close}
        >
          {spec && open === chip.key && (
            EXECUTOR_FIELDS.has(spec.type) ? (
              <ExecutorEditor
                step={step}
                catalog={catalog}
                onPatch={(patch) => onChange?.(patchParams(def, step.id, patch))}
              />
            ) : spec.type === "select" ? (
              <SelectEditor
                spec={spec}
                value={typeof value === "string" ? value : ""}
                onPick={(next) => { onChange?.(patchParams(def, step.id, { [spec.key]: next })); close(); }}
              />
            ) : spec.type === "multi" ? (
              <MultiEditor
                spec={spec}
                values={Array.isArray(value) ? (value as string[]) : []}
                onToggle={(next) => onChange?.(patchParams(def, step.id, { [spec.key]: next }))}
              />
            ) : spec.type === "text" ? (
              <TextEditor
                spec={spec}
                value={typeof value === "string" ? value : ""}
                onChange={(next) => onChange?.(patchParams(def, step.id, { [spec.key]: next.trim() || null }))}
              />
            ) : null
          )}
        </ChipSlot>
      ))}
      {fail && hasFailBranch(step.kind) && (
        <ChipSlot
          className="wf-failchip"
          label="这一站失败了怎么办"
          text={<><ArrowUUpLeft size={11} weight="bold" aria-hidden="true" />失败 → {fail}</>}
          disabled={!editable}
          open={open === "fail"}
          onToggle={() => setOpen((current) => (current === "fail" ? null : "fail"))}
          onClose={close}
        >
          <FailEditor step={step} onPatch={(patch) => onChange?.(patchFail(def, step.id, patch))} />
        </ChipSlot>
      )}
    </div>
  );
}

function AddStop({
  def, at, onChange,
}: {
  def: WorkflowDef;
  at: number;
  onChange: (def: WorkflowDef) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!canAddStep(def)) return <div className="wf-seg" />;
  return (
    <div className="wf-seg">
      <button
        type="button"
        ref={anchor}
        className="wf-add"
        aria-label={`在第 ${at + 1} 站前面加一站`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Plus size={11} weight="bold" aria-hidden="true" />
      </button>
      {open && (
        <Popover anchorRef={anchor} label="加一站" onClose={() => setOpen(false)}>
          <div className="wf-pop-options">
            {STEP_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className="wf-pop-option"
                disabled={!canAddKind(def, kind)}
                onClick={() => { onChange(insertStep(def, at, kind)); setOpen(false); }}
              >
                {STEP_LABELS[kind]}
              </button>
            ))}
          </div>
          {/* 只有「让 AI 干活」「合并并清理」各限一站（理由见 shared 的 SINGLETON_KINDS）；
              「自动验证」「等我点头」想加几站加几站。已经有了的在这儿灰掉并说明白，
              而不是让用户加完之后再被保存时的红字打回。 */}
          {STEP_KINDS.some((kind) => !canAddKind(def, kind)) && (
            <p className="wf-pop-hint">灰掉的站这条线上已经有了 —— 「让 AI 干活」和「合并并清理」各只能有一站。</p>
          )}
        </Popover>
      )}
    </div>
  );
}

export function WorkflowRail({
  def, onChange, task, issues = [], className,
}: {
  def: WorkflowDef;
  onChange?: (def: WorkflowDef) => void;
  task?: Pick<Task, "status" | "stage" | "question"> | null;
  issues?: WorkflowIssue[];
  className?: string;
}) {
  const catalog = useExecutorCatalog();
  const stops = railStops(def, task ?? null);
  const editable = !!onChange;

  if (!def.steps.length) {
    return (
      <div className={`wf-rail-empty${className ? ` ${className}` : ""}`}>
        这条线上还没有站。
        {onChange && (
          <button type="button" className="wf-add-first" onClick={() => onChange(insertStep(def, 0, "run"))}>
            ＋ 加第一站
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`wf-rail-scroll${className ? ` ${className}` : ""}`}>
      {/* 三行 grid，站与连接段交替成列：名牌 / 线上的站点 / 站台底下的参数与状态。
          段和站是兄弟元素而不是嵌套，才能让三行在所有列上严格对齐。 */}
      <div
        className="wf-rail"
        data-editable={editable ? "yes" : "no"}
        data-dense={stops.length >= DENSE_FROM ? "yes" : "no"}
      >
        {onChange ? <AddStop def={def} at={0} onChange={onChange} /> : <div className="wf-seg" />}
        {stops.map((stop, i) => {
          const trouble = issues.some((issue) => issue.stepId === stop.step.id);
          const tone = `is-${stop.state}${trouble ? " has-issue" : ""}`;
          return (
            <Fragment key={stop.step.id}>
              <div className={`wf-plate ${tone}`}>
                {editable && (
                  <div className="wf-ops">
                    <button type="button" aria-label="往前挪" disabled={i === 0}
                      onClick={() => onChange?.(moveStep(def, stop.step.id, -1))}>←</button>
                    <button type="button" aria-label="往后挪" disabled={i === stops.length - 1}
                      onClick={() => onChange?.(moveStep(def, stop.step.id, 1))}>→</button>
                    <button type="button" aria-label="拆掉这一站" className="wf-op-del"
                      onClick={() => onChange?.(removeStep(def, stop.step.id))}>✕</button>
                  </div>
                )}
                <span className="wf-short">{STEP_SHORT[stop.step.kind]}</span>
                <h4>{STEP_LABELS[stop.step.kind]}</h4>
              </div>
              <div className={`wf-node ${tone}`}><i>{String(i + 1).padStart(2, "0")}</i></div>
              <StepBody
                def={def}
                step={stop.step}
                catalog={catalog}
                statusLabel={stop.statusLabel}
                note={stop.note}
                tone={tone}
                onChange={onChange}
              />
              {onChange
                ? <AddStop def={def} at={i + 1} onChange={onChange} />
                : <div className="wf-seg" />}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
