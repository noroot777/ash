// 新建任务面板里的「干完之后」一节。
//
// 三层作用域在这儿只是一句话：默认**跟着项目走**，来源就写在标题旁边那颗标签上。
// 用户在这儿动一下，它自动变成「这个任务自己定」，并给一句「存成起手式」——继承关系
// 不用先学，改了才需要知道。
//
// 起手式是快照：这一次挑的、改的，只影响这一个任务；库里的那条不会跟着变，反过来
// 之后改库也不会追着改这个任务。
import { useCallback, useMemo, useRef, useState } from "react";
import type { ProjectView } from "@harness/shared";
import type { WorkflowDef, WorkflowItem } from "@harness/shared/workflow";
import { checkWorkflow, resolveWorkflowFromList, workflowDenied } from "@harness/shared/workflow";
import { DEFAULT_WORKFLOW_KEY } from "@harness/shared/workflow-presets";
import { CaretDown, FlowArrow } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { WorkflowMiniRail } from "../workflow/WorkflowMiniRail.tsx";
import { WorkflowRail } from "../workflow/WorkflowRail.tsx";
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

  const save = async () => {
    setBusy(true);
    try {
      const created = await api.createWorkflow({ name: name.trim(), description: "", def });
      forgetWorkflows();
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
      <label className="composer-wf-check">
        <input
          type="checkbox"
          checked={asProjectDefault}
          onChange={(event) => setAsProjectDefault(event.target.checked)}
        />
        同时设为「{project.name}」以后新建任务的默认
      </label>
    </ConfirmDialog>
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
  const menuBox = useRef<HTMLDivElement>(null);
  useDismissable({ enabled: menu, containerRef: menuBox, onClose: () => setMenu(false) });

  const { item, def } = resolveChoice(
    choice,
    items,
    { ...project, workflowId: projectDefaultId || null },
    globalDefaultId,
  );
  if (!def) return null;

  const denied = workflowDenied(def);
  const issues = checkWorkflow(def);
  const source = choice.custom
    ? "这个任务自己定"
    : choice.pickedId
      ? "这次挑的"
      : projectDefaultId
        ? `跟随本项目 · ${project.name}`
        : "跟随系统默认";

  const edit = (next: WorkflowDef) => onChange({ ...choice, custom: next });

  return (
    <section className="composer-config-section is-workflow">
      <header className="composer-section-heading">
        <span><FlowArrow size={14} /></span>
        <div><h2>干完之后</h2><p>谁来验、什么时候停下等你、过了要不要合并。</p></div>
        <button type="button" className="composer-wf-grow" onClick={() => setOpen((value) => !value)}>
          {open ? "收起编排" : "展开编排"}
        </button>
      </header>

      <div className="composer-wf-pick">
        <span className="composer-wf-label">
          起手式<em data-own={choice.custom ? "yes" : "no"}>{source}</em>
        </span>
        <div className="composer-wf-selwrap" ref={menuBox}>
          <button
            type="button"
            className="composer-wf-sel"
            aria-expanded={menu}
            onClick={() => setMenu((value) => !value)}
          >
            {choice.custom ? `自定义（从「${item?.name ?? "默认"}」改的）` : item?.name ?? "系统推荐"}
            <CaretDown size={12} aria-hidden="true" />
          </button>
          {menu && (
            <div className="wf-pop composer-wf-menu" role="dialog" aria-label="这条线用哪个起手式">
              <div className="wf-pop-title">这条线用哪个起手式</div>
              <div className="wf-pop-options">
                <button
                  type="button"
                  className={`wf-pop-option${!choice.pickedId && !choice.custom ? " is-on" : ""}`}
                  onClick={() => { onChange(emptyWorkflowChoice); setMenu(false); }}
                >
                  {projectDefaultId ? `跟随本项目 · ${project.name}` : "跟随系统默认"}
                </button>
                {items.filter((row) => !row.disabled).map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className={`wf-pop-option${choice.pickedId === row.id && !choice.custom ? " is-on" : ""}`}
                    onClick={() => { onChange({ pickedId: row.id, custom: null }); setMenu(false); }}
                  >
                    {row.name}
                  </button>
                ))}
              </div>
              <p className="wf-pop-hint">挑一个只影响这一个任务；在下面改任何一处，它就变成「自定义」。</p>
            </div>
          )}
        </div>
      </div>

      {open
        ? <WorkflowRail def={def} issues={issues} onChange={edit} className="composer-wf-rail" />
        : <WorkflowMiniRail def={def} onChange={edit} />}

      {denied.length > 0 && (
        <div className="wf-deny">这条线现在建不出来：{denied.map((issue) => issue.text).join("；")}</div>
      )}

      {choice.custom && (
        <div className="composer-wf-fork">
          <span><b>只影响这一个任务</b>本项目的默认没被动过</span>
          <span className="composer-wf-forkops">
            <button type="button" onClick={() => onChange({ pickedId: choice.pickedId, custom: null })}>
              改回原样
            </button>
            <button type="button" onClick={() => setSaving(true)}>存成起手式…</button>
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
