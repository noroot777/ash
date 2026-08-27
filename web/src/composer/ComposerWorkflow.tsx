// 新建任务面板里的「干完之后」一节。
//
// 三层作用域在这儿只是一句话：默认**跟着项目走**，来源就写在标题旁边那颗标签上。
// 用户在这儿动一下，它自动变成「这个任务自己定」，并给一句「存成起手式」——继承关系
// 不用先学，改了才需要知道。
//
// 起手式是快照：这一次挑的、改的，只影响这一个任务；库里的那条不会跟着变，反过来
// 之后改库也不会追着改这个任务。
import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ProjectView } from "@ash/shared";
import type { WorkflowDef, WorkflowItem } from "@ash/shared/workflow";
import { checkWorkflow, resolveWorkflowFromList, workflowDenied } from "@ash/shared/workflow";
import { DEFAULT_WORKFLOW_KEY } from "@ash/shared/workflow-presets";
import { CaretDown, FlowArrow } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { useAuth } from "../auth/authContext.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { Popover } from "../workflow/Popover.tsx";
import { WorkflowMiniRail } from "../workflow/WorkflowMiniRail.tsx";
import { WorkflowRail } from "../workflow/WorkflowRail.tsx";
import { STEP_HUE, workflowCost, workflowSummary } from "../workflow/workflowModel.ts";
import { forgetWorkflows, useWorkflows } from "../workflow/WorkflowPicker.tsx";

export interface WorkflowChoice {
  /** 用户显式挑的起手式 id；"" = 跟着项目/系统默认走 */
  pickedId: string;
  /** 就地改过的线；null = 原样用起手式那条 */
  custom: WorkflowDef | null;
}

export const emptyWorkflowChoice: WorkflowChoice = { pickedId: "", custom: null };

/** 面板上显示的、以及最终提交的那条线：跟服务端用的是同一个挑选函数。 */
export function resolveChoice(
  choice: WorkflowChoice,
  items: WorkflowItem[],
  project: ProjectView,
  globalDefaultId: string,
): { item: WorkflowItem | null; def: WorkflowDef | null } {
  const chain = [choice.pickedId, project.workflowId ?? "", globalDefaultId, DEFAULT_WORKFLOW_KEY];
  const item = resolveWorkflowFromList(items, chain, choice.pickedId);
  return { item, def: choice.custom ?? item?.def ?? null };
}

function SaveAsPresetDialog({
  def, project, defaultName, onClose, notify,
}: {
  def: WorkflowDef;
  project: ProjectView;
  defaultName: string;
  onClose: (savedId: string | null, madeProjectDefault: boolean) => void;
  notify: (message: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [asProjectDefault, setAsProjectDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const { state } = useAuth();
  // 「顺手设成项目默认」只在自用模式下成立:多人模式里存出来的是个人起手式,别人看不见,
  // 设成共享项目的默认只会让他们的新任务静默落回系统默认(第 6 轮审查 P1)。
  const canSetDefault = state.mode !== "multi" && project.myRole === "admin";

  const save = async () => {
    setBusy(true);
    try {
      const created = await api.createWorkflow({ name: name.trim(), description: "", def });
      // **先等库刷新**再把选中值切到新存的那条：不等的话那一刻 items 里还没有它，
      // resolveChoice 会把这个 id 当悬空回落到项目/全局默认——用户刚编排好的线就没了。
      await forgetWorkflows();
      if (asProjectDefault) await api.updateProject(project.id, { workflowId: created.id });
      notify(asProjectDefault ? `已存成起手式，并设为「${project.name}」的默认` : "已存成起手式");
      onClose(created.id, asProjectDefault);
    } catch (error) {
      notify(error instanceof Error ? error.message : "存成起手式失败");
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      title="把这条线存成起手式"
      message="存进起手式库之后，以后新建任务可以直接挑它。当前这个任务用的仍然是它自己那份快照。"
      confirmLabel="存下来"
      busy={busy}
      confirmDisabled={!name.trim()}
      onConfirm={() => void save()}
      onClose={() => onClose(null, false)}
    >
      <label className="composer-wf-field">
        <span>名字</span>
        <input value={name} autoFocus onChange={(event) => setName(event.target.value)} />
      </label>
      {canSetDefault ? (
        <label className="composer-wf-check">
          <input
            type="checkbox"
            checked={asProjectDefault}
            onChange={(event) => setAsProjectDefault(event.target.checked)}
          />
          同时设为「{project.name}」以后新建任务的默认
        </label>
      ) : (
        // 多人模式下这条路是死的:存下来的是**个人**起手式,别人看不见它,所以它当不了共享
        // 项目的默认(后端同样 400)。与其让人勾了再吃一个报错,不如当场说清楚。
        <p className="composer-wf-check">存下来只归你自己用；项目默认起手式只能选系统自带的那几条。</p>
      )}
    </ConfirmDialog>
  );
}

/** 一串站台颜色点：不读字也能看出这条线有几站、哪几类。 */
function Dots({ def }: { def: WorkflowDef | null }) {
  if (!def?.steps.length) return null;
  return (
    <span className="wf-dots" aria-hidden="true">
      {def.steps.map((step) => (
        <u key={step.id} style={{ background: STEP_HUE[step.kind] } as CSSProperties} />
      ))}
    </span>
  );
}

export function ComposerWorkflow({
  choice, items, project, projectDefaultId, globalDefaultId, onChange, onProjectDefault, notify,
}: {
  choice: WorkflowChoice;
  items: WorkflowItem[];
  project: ProjectView;
  projectDefaultId: string;
  globalDefaultId: string;
  onChange: (choice: WorkflowChoice) => void;
  onProjectDefault: (workflowId: string) => void;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);

  const { item, def } = resolveChoice(
    choice,
    items,
    { ...project, workflowId: projectDefaultId || null },
    globalDefaultId,
  );
  if (!def) return null;

  const denied = workflowDenied(def);
  const issues = checkWorkflow(def);
  const cost = workflowCost(def);
  const source = choice.custom
    ? "这个任务自己定"
    : choice.pickedId
      ? "这次挑的"
      : projectDefaultId
        // 项目默认**真的命中了**才敢写「跟随本项目」。起手式按人隔离,项目行里那条可能是
        // 别人的个人起手式:对我来说它解析不出来,链条会往下落到系统默认 —— 这时标成
        // 「跟随本项目」就是当面说假话,而实际跑的线跟项目管理员以为的完全不是一条
        // (第 6 轮审查 P1)。
        ? item?.id === projectDefaultId
          ? `跟随本项目 · ${project.name}`
          : "本项目的默认起手式你看不到，已落到系统默认"
        : "跟随系统默认";
  // 下拉框上永远写「这条线现在是什么」：改过就明说是从哪个起手式改的，副标题退回成
  // 这条线自己的走法，免得挂着一个已经不作数的模板描述。
  const pickedName = choice.custom
    ? `自定义（从「${item?.name ?? "默认"}」改的）`
    : item?.name ?? "系统推荐";
  const pickedDesc = choice.custom
    ? `共 ${def.steps.length} 站 · ${workflowSummary(def)}`
    : item?.description?.trim() || workflowSummary(def);

  const edit = (next: WorkflowDef) => onChange({ ...choice, custom: next });

  return (
    <section className="composer-config-section is-workflow">
      <header className="composer-section-heading">
        <span><FlowArrow size={14} /></span>
        <div><h2>干完之后</h2><p>谁来验、什么时候停下等你、过了要不要合并。</p></div>
        <button type="button" className="composer-wf-grow" onClick={() => setOpen((value) => !value)}>
          {open ? "收起" : "展开编排"}
        </button>
      </header>

      <div className="composer-wf-pick">
        <span className="composer-wf-label">
          起手式<em data-own={choice.custom ? "yes" : "no"}>{source}</em>
        </span>
        <button
          type="button"
          ref={menuAnchor}
          className="composer-wf-sel"
          aria-expanded={menu}
          onClick={() => setMenu((value) => !value)}
        >
          <b>{pickedName}</b>
          <Dots def={def} />
          <small>{pickedDesc}</small>
          <CaretDown size={12} aria-hidden="true" />
        </button>
        {menu && (
          <Popover
            anchorRef={menuAnchor}
            label="这条线用哪个起手式"
            align="start"
            matchWidth
            onClose={() => setMenu(false)}
          >
            <div className="wf-pop-options">
              <button
                type="button"
                className={`wf-pop-option wf-pop-tpl${!choice.pickedId && !choice.custom ? " is-on" : ""}`}
                onClick={() => { onChange(emptyWorkflowChoice); setMenu(false); }}
              >
                {projectDefaultId ? `跟随本项目 · ${project.name}` : "跟随系统默认"}
                <span className="wf-pop-sub">改了它，所有新任务一起变</span>
              </button>
              {items.filter((row) => !row.disabled).map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={`wf-pop-option wf-pop-tpl${choice.pickedId === row.id && !choice.custom ? " is-on" : ""}`}
                  onClick={() => { onChange({ pickedId: row.id, custom: null }); setMenu(false); }}
                >
                  {row.name}
                  <Dots def={row.def} />
                  <span className="wf-pop-sub">{row.description?.trim() || workflowSummary(row.def)}</span>
                </button>
              ))}
            </div>
            <p className="wf-pop-hint">挑一个只影响这一个任务；在下面改任何一处，它就变成「自定义」。</p>
          </Popover>
        )}
      </div>

      {open
        ? <WorkflowRail def={def} issues={issues} onChange={edit} className="composer-wf-rail" />
        : <WorkflowMiniRail def={def} onChange={edit} />}

      {/* 这条线要花掉什么 —— 三个数都从定义直接数得出来，不是预演出来的估计值 */}
      <div className="composer-wf-cost">
        <span>顺利走完 <b>{cost.steps}</b> 步</span>
        <span aria-hidden="true">·</span>
        <span>要你出面 <b>{cost.gates}</b> 次</span>
        <span aria-hidden="true">·</span>
        <span>不顺利最多起 <b>{cost.aiRuns}</b> 次 AI</span>
      </div>

      {denied.length > 0 && (
        <div className="wf-deny">这条线现在建不出来：{denied.map((issue) => issue.text).join("；")}</div>
      )}

      {choice.custom && (
        <div className="composer-wf-fork">
          <span><b>只影响这一个任务</b>本项目的默认没被动过</span>
          <span className="composer-wf-forkops">
            <button type="button" onClick={() => setSaving(true)}>存成起手式…</button>
            <button type="button" onClick={() => onChange({ pickedId: choice.pickedId, custom: null })}>
              还原成{projectDefaultId ? "本项目的" : "原样"}
            </button>
          </span>
        </div>
      )}

      {saving && (
        <SaveAsPresetDialog
          def={def}
          project={project}
          defaultName={item ? `${item.name} 改` : "我的起手式"}
          notify={notify}
          onClose={(savedId, madeProjectDefault) => {
            setSaving(false);
            if (!savedId) return;
            // 存下来之后这条线就有名字了：把「自定义」收回成「挑了这一条」，
            // 免得面板上继续显示成一条无名的改动。
            onChange({ pickedId: savedId, custom: null });
            if (madeProjectDefault) onProjectDefault(savedId);
          }}
        />
      )}
    </section>
  );
}

/**
 * 「干完之后」那一节的全部状态。
 *
 * 拎出来是因为它自成一件事:挑哪条线、就地改的那份、两级默认从哪来,新建面板不需要
 * 知道其中任何一条,只要拿到 `slot` 往里一放、提交时把 `workflowId`/`def` 带上。
 */
export function useComposerWorkflow({
  project, isRepo, notify, onWorkspace,
}: {
  project: ProjectView;
  isRepo: boolean;
  notify: (message: string) => void;
  /** 换起手式时把「在哪儿干活」拨到它写的那一档 */
  onWorkspace: (isolated: boolean) => void;
}) {
  const [choice, setChoice] = useState<WorkflowChoice>(emptyWorkflowChoice);
  const [globalDefaultId, setGlobalDefaultId] = useState("");
  const [projectDefaultId, setProjectDefaultId] = useState(project.workflowId ?? "");
  const items = useWorkflows();
  const scope = useMemo(
    () => ({ ...project, workflowId: projectDefaultId || null }),
    [project, projectDefaultId],
  );
  // 面板上画的那条线,就是提交时送出去的那条线:同一个挑选函数、同一份定义。
  const def = useMemo(
    () => resolveChoice(choice, items, scope, globalDefaultId).def,
    [choice, items, scope, globalDefaultId],
  );

  // worktree 开关是「在哪儿干活」的唯一开关,两处各写各的迟早对不上。换起手式时把它
  // 拨过去,拨完用户还能自己改,最终以开关上的为准。
  const pick = useCallback((next: WorkflowChoice) => {
    setChoice((current) => {
      if (next.pickedId !== current.pickedId && isRepo) {
        const picked = resolveChoice(next, items, scope, globalDefaultId).def;
        if (picked) onWorkspace(picked.workspace === "isolated");
      }
      return next;
    });
  }, [items, scope, globalDefaultId, isRepo, onWorkspace]);

  return {
    def,
    workflowId: choice.pickedId || null,
    setGlobalDefaultId,
    slot: (
      <ComposerWorkflow
        choice={choice}
        items={items}
        project={project}
        projectDefaultId={projectDefaultId}
        globalDefaultId={globalDefaultId}
        onChange={pick}
        onProjectDefault={setProjectDefaultId}
        notify={notify}
      />
    ),
  };
}
