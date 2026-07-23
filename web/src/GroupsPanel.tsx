import { useState } from "react";
import type { Group, Task, GroupMode } from "@harness/shared";
import { Stack, Play, Pause, Trash, Plus } from "@phosphor-icons/react";
import { Modal, ConfirmModal } from "./Modal";

// 续跑队列条：把组里所有任务按 resumeDependsOn 拓扑顺序排开，每个位置用一个圆点标记
// 当前状态。只对「带检查点续跑」的组显示（即组里至少有一个 paused 任务）—— 普通
// 组不会平白多出一条 UI。dr-dig-ytb 这种「pre-tts 并行 + tts 串行」流水线里，
// 用户在 panel 这一层最想确认的就是「整支队伍跑到第几个、按 rank 顺序在不在」。
function ResumeQueueBar({ tasks }: { tasks: Task[] }) {
  if (!tasks.some((t) => t.status === "paused")) return null;
  // 拓扑排：能放进 ready 的就是 resumeDependsOn 已经全部出现在已排好里的；环 / 跨组依赖
  // 自然忽略。createdAt 兜底次序，保证同一拓扑层内显示稳定。
  const inSet = new Set(tasks.map((t) => t.id));
  const placed = new Set<string>();
  const ordered: Task[] = [];
  const pool = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  while (pool.length) {
    const i = pool.findIndex((t) => t.resumeDependsOn.every((d) => !inSet.has(d) || placed.has(d)));
    const t = i >= 0 ? pool.splice(i, 1)[0] : pool.shift()!;
    placed.add(t.id);
    ordered.push(t);
  }
  const dot = (t: Task) => {
    if (t.status === "done") return { ch: "✅", cls: "text-emerald-500" };
    if (t.status === "running") return { ch: "●", cls: "text-amber-500" };
    if (t.status === "paused") return { ch: "○", cls: "text-cyan-500" };
    if (t.status === "queued") return { ch: "○", cls: "text-amber-400/70" };
    if (t.status === "failed") return { ch: "✕", cls: "text-red-500" };
    if (t.status === "canceled") return { ch: "○", cls: "text-neutral-400" };
    return { ch: "○", cls: "text-neutral-500" };
  };
  const doneCount = tasks.filter((t) => t.status === "done").length;
  return (
    <div className="flex w-full items-center gap-2 px-1 pb-1 text-[11px]">
      <span className="shrink-0 text-faint">续跑队列</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-[3px] font-mono leading-none">
        {ordered.map((t) => {
          const d = dot(t);
          return (
            <span key={t.id} className={d.cls} title={`${t.title} · ${t.status}`}>
              {d.ch}
            </span>
          );
        })}
      </div>
      <span className="shrink-0 font-mono text-faint">
        {doneCount}/{tasks.length}
      </span>
    </div>
  );
}

// 编排组:协调者选择行。选中组内某个任务当协调者后,组内其它任务结束(done/
// failed)或提问(ask_question)时 harness 自动用消息唤醒它;撤销即退回普通组。
// 协调者不能在本组串行队列里 —— server 会 409,错误经 onSetCoordinator 的
// toast 透出,这里不重复校验。
function CoordinatorRow({
  group,
  tasks,
  onSet,
}: {
  group: Group;
  tasks: Task[];
  onSet: (taskId: string | null) => void;
}) {
  const candidates = tasks.filter((t) => !t.archived);
  const current = group.coordinatorTaskId ?? "";
  return (
    <div className="flex w-full items-center gap-2 px-1 pb-1 text-[11px]">
      <span className="shrink-0 text-faint" title="编排组:worker 结束/提问会自动唤醒协调者;协调者不能排在本组串行队列里">
        协调者
      </span>
      <select
        value={current}
        onChange={(e) => {
          const v = e.target.value || null;
          if (v !== (group.coordinatorTaskId ?? null)) onSet(v);
        }}
        className="min-w-0 max-w-[16rem] flex-1 truncate rounded-md border border-line bg-canvas px-1.5 py-0.5 text-[11px] text-ink outline-none focus:border-accent"
      >
        <option value="">（无 — 普通组）</option>
        {candidates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
      </select>
      {current && (
        <span className="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
          编排组
        </span>
      )}
    </div>
  );
}

// Manage a project's groups (transient parallel/serial batches, §3): rename,
// switch parallel/serial, see member count, run, pause,
// or delete (members are kept — just ungrouped). Inline create at the bottom.
export function GroupsPanel({
  groups,
  tasks,
  onClose,
  onRun,
  onPause,
  onUpdate,
  onDelete,
  onCreate,
  onSetCoordinator,
}: {
  groups: Group[];
  tasks: Task[];
  onClose: () => void;
  onRun: (id: string) => void;
  onPause: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Pick<Group, "name" | "mode">>) => void;
  onDelete: (id: string) => void;
  onCreate: (name: string, mode: GroupMode) => void;
  onSetCoordinator: (id: string, taskId: string | null) => void;
}) {
  const [confirmDel, setConfirmDel] = useState<Group | null>(null);
  const [newName, setNewName] = useState("");
  const count = (id: string) => tasks.filter((t) => t.groupId === id).length;
  const groupTasks = (id: string) => tasks.filter((t) => t.groupId === id);
  const create = () => {
    if (newName.trim()) {
      onCreate(newName.trim(), "parallel");
      setNewName("");
    }
  };
  return (
    <>
      <Modal title="分组管理" onClose={onClose} width={680}>
        <div className="flex flex-col gap-2">
          {groups.length === 0 && (
            <p className="text-[13px] text-faint">还没有分组。分组用来把同质化的任务打包，按并行或串行整组运行。</p>
          )}
          {groups.map((g) => (
            <div key={g.id} className="flex flex-col gap-1 rounded-lg border border-line bg-canvas px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <Stack size={14} className="shrink-0 text-faint" />
              <input
                defaultValue={g.name}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== g.name) onUpdate(g.id, { name: v });
                  else e.target.value = g.name;
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                className="min-w-[6rem] flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[13px] font-medium text-ink outline-none hover:border-line focus:border-accent focus:bg-panel"
              />
              <div className="flex shrink-0 overflow-hidden rounded-md border border-line text-[12px]">
                {(["parallel", "serial"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => g.mode !== m && onUpdate(g.id, { mode: m })}
                    className={`px-2.5 py-1 ${g.mode === m ? "bg-accent text-accent-fg" : "text-muted hover:bg-raised"}`}
                  >
                    {m === "parallel" ? "并行" : "串行"}
                  </button>
                ))}
              </div>
              <span className="shrink-0 text-[12px] text-faint">{count(g.id)} 个任务</span>
              {g.paused ? (
                <>
                  <span className="ml-auto shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">已暂停</span>
                  <button
                    onClick={() => onRun(g.id)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-fg hover:bg-accent-hover"
                    title="继续：恢复未开始的任务，并从中断处接着跑被暂停打断的那个"
                  >
                    <Play size={12} weight="fill" /> 继续
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => onRun(g.id)}
                    className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-fg hover:bg-accent-hover"
                    title="运行整组"
                  >
                    <Play size={12} weight="fill" /> 运行
                  </button>
                  <button
                    onClick={() => onPause(g.id)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line2 px-2.5 py-1 text-[12px] font-medium text-muted hover:bg-raised hover:text-ink"
                    title="暂停：立刻冻结整组——未开始的挂起，正在运行的也停掉（可继续）；再点「运行/继续」恢复"
                  >
                    <Pause size={12} weight="fill" /> 暂停
                  </button>
                </>
              )}
              <button
                onClick={() => setConfirmDel(g)}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-raised hover:text-red-600"
                title="删除分组"
              >
                <Trash size={14} />
              </button>
            </div>
            <CoordinatorRow group={g} tasks={groupTasks(g.id)} onSet={(taskId) => onSetCoordinator(g.id, taskId)} />
            <ResumeQueueBar tasks={groupTasks(g.id)} />
            </div>
          ))}
          <div className="mt-1 flex items-center gap-2 border-t border-line pt-3">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              placeholder="新建分组名…（默认并行，回车创建）"
              className="flex-1 rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint focus:border-accent"
            />
            <button
              disabled={!newName.trim()}
              onClick={create}
              className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40"
            >
              <Plus size={13} weight="bold" /> 新建
            </button>
          </div>
        </div>
      </Modal>
      {confirmDel && (
        <ConfirmModal
          title="删除分组"
          message={`确定删除分组「${confirmDel.name}」？组内 ${count(confirmDel.id)} 个任务不会被删除，只会取消分组。`}
          confirmLabel="删除"
          danger
          onConfirm={() => onDelete(confirmDel.id)}
          onClose={() => setConfirmDel(null)}
        />
      )}
    </>
  );
}
