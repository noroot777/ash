// 收起态的那条线：一排站名，中间常驻虚线 ＋。
//
// 它不是「简化版线路图」，是**同一条线的另一个尺寸**：每一站照样带序号、带这一类站的
// 颜色、带参数（「让 codex@cpa 干活」而不是泛泛的「让 AI 干活」），点下去能把这一站的
// 事都办了（改参数、往前往后挪、拆掉）。展开态多出来的只是把参数摊开摆在站台底下，
// 信息本身一样多。
//
// 只在新建任务面板里用：那儿一屏要装下七八节配置，这条线不能占三行以上。
import { Fragment, useRef, useState, type CSSProperties } from "react";
import type { WorkflowDef, WorkflowStep } from "@harness/shared/workflow";
import { STEP_KINDS, STEP_LABELS } from "@harness/shared/workflow";
import { Plus } from "@phosphor-icons/react";
import { Popover } from "./Popover.tsx";
import { StepMenuBody, useStepMenu } from "./StepMenu.tsx";
import { executorName, useExecutorCatalog, type ExecutorCatalog } from "./executorCatalog.ts";
import { STEP_HUE, stepTitle } from "./workflowModel.ts";
import { canAddKind, canAddStep, insertStep } from "./workflowEdit.ts";

const tone = (hue: string) => ({ "--tone": hue }) as CSSProperties;

function MiniStop({
  def, step, index, catalog, onChange,
}: {
  def: WorkflowDef;
  step: WorkflowStep;
  index: number;
  catalog: ExecutorCatalog;
  onChange?: (def: WorkflowDef) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const menu = useStepMenu(step, index);
  const close = () => { menu.setDrill(null); setOpen(false); };

  return (
    <span className="wf-mini-slot">
      <button
        type="button"
        ref={anchor}
        className="wf-mini-stop"
        style={tone(STEP_HUE[step.kind])}
        disabled={!onChange}
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <i className="wf-mini-dot" aria-hidden="true" />
        <span className="wf-mini-no">{String(index + 1).padStart(2, "0")}</span>
        {stepTitle(step, (id) => executorName(catalog, id))}
      </button>
      {open && onChange && (
        <Popover
          anchorRef={anchor}
          label={menu.label}
          onBack={menu.back ?? undefined}
          onClose={close}
        >
          <StepMenuBody
            def={def}
            step={step}
            index={index}
            catalog={catalog}
            view={menu}
            setDrill={menu.setDrill}
            onChange={onChange}
            onClose={close}
          />
        </Popover>
      )}
    </span>
  );
}

function MiniGap({
  def, at, onChange,
}: {
  def: WorkflowDef;
  at: number;
  onChange: (def: WorkflowDef) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!canAddStep(def)) return <i className="wf-mini-gap" aria-hidden="true" />;

  return (
    <span className="wf-mini-gap is-add">
      <button
        type="button"
        ref={anchor}
        className="wf-mini-add"
        aria-label={at >= def.steps.length ? "在末尾加一站" : `在第 ${at + 1} 站前面加一站`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Plus size={10} weight="bold" aria-hidden="true" />
      </button>
      {open && (
        <Popover anchorRef={anchor} label="在这儿加一站" onClose={() => setOpen(false)}>
          <div className="wf-pop-options">
            {STEP_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className="wf-pop-option wf-pop-kind"
                style={tone(STEP_HUE[kind])}
                disabled={!canAddKind(def, kind)}
                onClick={() => { onChange(insertStep(def, at, kind)); setOpen(false); }}
              >
                <i aria-hidden="true" />{STEP_LABELS[kind]}
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
    </span>
  );
}

export function WorkflowMiniRail({
  def, onChange,
}: {
  def: WorkflowDef;
  onChange?: (def: WorkflowDef) => void;
}) {
  const catalog = useExecutorCatalog();

  if (!def.steps.length) {
    return (
      <div className="wf-mini is-empty">
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
    <div className="wf-mini">
      {def.steps.map((step, i) => (
        <Fragment key={step.id}>
          {/* 头一站前面不摆 ＋：线是从左边长出来的，那儿再摆个加号会让人以为线还没开始 */}
          {i > 0 && (onChange
            ? <MiniGap def={def} at={i} onChange={onChange} />
            : <i className="wf-mini-gap" aria-hidden="true" />)}
          <MiniStop def={def} step={step} index={i} catalog={catalog} onChange={onChange} />
        </Fragment>
      ))}
      {onChange && <MiniGap def={def} at={def.steps.length} onChange={onChange} />}
    </div>
  );
}
