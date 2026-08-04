// 设置 › 起手式。
//
// 产品口径（四条，都在 server 的 workflow-library 那一层钉死了）：
// ① 系统自带的**能改**，改的就是它本身，不会偷偷 fork 出一份副本；
// ② 改过就带「已改过」标记，旁边永远留着「恢复系统默认」，所以改坏了不心疼；
// ③ 系统自带的**删不掉**，只能停用 —— 「删了再也拿不回来」对内置物件是假承诺；
// ④ 改起手式**不会追着改已有任务**：任务创建那一刻就把线拷进自己兜里了。
//
// 保存是自动的（改完即生效，跟 ③④ 一起构成「你改的就是它本身」这套语义），但只在
// 这条线过得了闸的时候写；过不了就顶着红条等你改好，不会把一条存不进去的线写下去。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowDef, WorkflowItem } from "@harness/shared/workflow";
import { WORKSPACE_LABELS, checkWorkflow, makeStep, workflowDenied } from "@harness/shared/workflow";
import { ArrowCounterClockwise, Copy, Plus, Prohibit, TrashSimple } from "@phosphor-icons/react";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { api } from "../lib/api.ts";
import { WorkflowRail } from "../workflow/WorkflowRail.tsx";
import { forgetWorkflows } from "../workflow/WorkflowPicker.tsx";
import { workflowSummary } from "../workflow/workflowModel.ts";

// 「空白」不是真空白：一条线至少得有「干活」那一站（没有 run 站过不了闸），
// 所以新建给的是「只有干活一站」，剩下的让用户往上加。
const BLANK: WorkflowDef = { workspace: "isolated", steps: [makeStep("run", "s1")] };

function LibraryRow({
  item, active, onPick,
}: {
  item: WorkflowItem;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button type="button" className="ui-selectable wf-lib-row" aria-selected={active} onClick={onPick}>
      <span className="wf-lib-name">
        {item.name}
        {item.modified && <em className="wf-tag is-edited">已改过</em>}
        {item.disabled && <em className="wf-tag">已停用</em>}
      </span>
      <small>{workflowSummary(item.def)}</small>
    </button>
  );
}

export function WorkflowsSettings({ notify }: { notify: (message: string) => void }) {
  const [items, setItems] = useState<WorkflowItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<WorkflowItem | null>(null);
  const saveTimer = useRef<number | null>(null);

  const load = useCallback(async (pick?: string) => {
    try {
      const list = await api.workflows();
      setItems(list);
      setActiveId((current) => pick ?? current ?? list[0]?.id ?? null);
    } catch (error) {
      notify(error instanceof Error ? error.message : "起手式读取失败");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);

  // 切换选中项时把草稿换成它。草稿只是「界面上正在看的那一份」，保存成功后回填。
  useEffect(() => {
    setDraft(items.find((item) => item.id === activeId) ?? null);
  }, [activeId, items]);

  const issues = useMemo(() => (draft ? checkWorkflow(draft.def) : []), [draft]);
  const denied = useMemo(() => issues.filter((issue) => issue.level === "deny"), [issues]);

  const save = useCallback(async (next: WorkflowItem, patch: Parameters<typeof api.patchWorkflow>[1]) => {
    try {
      const saved = await api.patchWorkflow(next.id, patch);
      setItems((list) => list.map((item) => (item.id === saved.id ? saved : item)));
      forgetWorkflows();
    } catch (error) {
      notify(error instanceof Error ? error.message : "起手式保存失败");
    }
  }, [notify]);

  // 线路图上每点一下都会进来一次，攒 400ms 再写；过不了闸就不写。
  const editDef = (def: WorkflowDef) => {
    if (!draft) return;
    const next = { ...draft, def };
    setDraft(next);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    if (workflowDenied(def).length) return;
    saveTimer.current = window.setTimeout(() => { void save(next, { def }); }, 400);
  };

  useEffect(() => () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); }, []);

  const create = async (from?: WorkflowItem) => {
    try {
      const created = await api.createWorkflow({
        name: from ? `${from.name} 副本` : "新起手式",
        description: from?.description ?? "",
        def: from ? from.def : BLANK,
      });
      forgetWorkflows();
      await load(created.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "新建起手式失败");
    }
  };

  const restore = async (item: WorkflowItem) => {
    try {
      const restored = await api.restoreWorkflow(item.id);
      forgetWorkflows();
      setItems((list) => list.map((row) => (row.id === restored.id ? restored : row)));
      setDraft(restored);
      notify(`「${restored.name}」已恢复系统默认`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "恢复系统默认失败");
    }
  };

  const remove = async (item: WorkflowItem) => {
    try {
      await api.deleteWorkflow(item.id);
      forgetWorkflows();
      setConfirmDelete(null);
      setActiveId(null);
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除起手式失败");
    }
  };

  const builtin = items.filter((item) => item.builtin && !item.disabled);
  const mine = items.filter((item) => !item.builtin && !item.disabled);
  const off = items.filter((item) => item.disabled);

  return (
    <>
      <header className="settings-heading">
        <div>
          <h1>起手式</h1>
          <p>
            新建任务时挑一条线起手，挑完还能改。系统自带的那几个也能改、能停用，
            改坏了随时恢复默认；任务在创建那一刻就把线拷进自己兜里，改这儿不会动到已有任务。
          </p>
        </div>
      </header>

      <section className="settings-section wf-lib">
        <div className="wf-lib-side">
          <div className="wf-lib-list">
            {builtin.length > 0 && <div className="wf-lib-group">系统自带 · 可改可停用</div>}
            {builtin.map((item) => (
              <LibraryRow key={item.id} item={item} active={item.id === activeId} onPick={() => setActiveId(item.id)} />
            ))}
            {mine.length > 0 && <div className="wf-lib-group">我自己建的</div>}
            {mine.map((item) => (
              <LibraryRow key={item.id} item={item} active={item.id === activeId} onPick={() => setActiveId(item.id)} />
            ))}
            {off.length > 0 && <div className="wf-lib-group">已停用 · 新建任务里看不到</div>}
            {off.map((item) => (
              <LibraryRow key={item.id} item={item} active={item.id === activeId} onPick={() => setActiveId(item.id)} />
            ))}
            {!loading && !items.length && <p className="wf-pop-hint">一个起手式都没有。</p>}
          </div>
          <button type="button" className="wf-lib-new" onClick={() => void create()}>
            <Plus size={12} weight="bold" aria-hidden="true" />
            新建起手式
          </button>
        </div>

        <div className="wf-lib-main">
          {!draft ? (
            <div className="settings-empty">{loading ? "读取中…" : "左边挑一个起手式。"}</div>
          ) : (
            <>
              <div className="settings-card wf-lib-head">
                <input
                  className="wf-lib-title"
                  value={draft.name}
                  aria-label="起手式名字"
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  onBlur={(event) => {
                    const name = event.target.value.trim();
                    if (name && name !== items.find((i) => i.id === draft.id)?.name) void save(draft, { name });
                  }}
                />
                <input
                  className="wf-lib-desc"
                  value={draft.description}
                  placeholder="一句话说明什么时候用它"
                  aria-label="起手式说明"
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  onBlur={(event) => void save(draft, { description: event.target.value.trim() })}
                />
                <div className="wf-lib-actions">
                  <button type="button" onClick={() => void create(draft)}>
                    <Copy size={13} aria-hidden="true" />复制一份
                  </button>
                  {draft.builtin && (
                    <button type="button" disabled={!draft.modified} onClick={() => void restore(draft)}>
                      <ArrowCounterClockwise size={13} aria-hidden="true" />恢复系统默认
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void save(draft, { disabled: !draft.disabled })}
                  >
                    <Prohibit size={13} aria-hidden="true" />{draft.disabled ? "重新启用" : "停用"}
                  </button>
                  {!draft.builtin && (
                    <button type="button" className="wf-danger" onClick={() => setConfirmDelete(draft)}>
                      <TrashSimple size={13} aria-hidden="true" />删除
                    </button>
                  )}
                </div>
                {draft.builtin && (
                  <p className="wf-pop-hint">
                    系统自带的删不掉，只能停用；停用后新建任务里看不到它，随时能恢复。
                  </p>
                )}
              </div>

              <div className="settings-card">
                <div className="settings-row">
                  <div>
                    <b>在哪儿干活</b>
                    <small>「单独开一份工作区」= 用 worktree，互不打扰；「直接在项目目录里」= 就地改</small>
                  </div>
                  <select
                    value={draft.def.workspace}
                    aria-label="在哪儿干活"
                    onChange={(event) => editDef({ ...draft.def, workspace: event.target.value as WorkflowDef["workspace"] })}
                  >
                    {Object.entries(WORKSPACE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {denied.length > 0 && (
                <div className="wf-deny">
                  这条线现在存不进去，先改好这个：{denied.map((issue) => issue.text).join("；")}
                </div>
              )}

              <div className="settings-card wf-lib-rail">
                <WorkflowRail def={draft.def} issues={issues} onChange={editDef} />
              </div>
            </>
          )}
        </div>
      </section>

      {confirmDelete && (
        <ConfirmDialog
          title="删除起手式"
          message={`删掉「${confirmDelete.name}」之后，新建任务里就挑不到它了。已经建好的任务不受影响。`}
          confirmLabel="删除"
          danger
          onConfirm={() => void remove(confirmDelete)}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}
