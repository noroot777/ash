import { useState } from "react";
import type { Group, Task, GroupMode } from "@harness/shared";
import { Stack, Play, Pause, Trash, Plus } from "@phosphor-icons/react";
import { Modal, ConfirmModal } from "./Modal";

// Manage a project's groups (transient parallel/serial batches, §3): rename,
// switch parallel/serial, toggle worktree isolation, see member count, run, pause,
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
}: {
  groups: Group[];
  tasks: Task[];
  onClose: () => void;
  onRun: (id: string) => void;
  onPause: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Pick<Group, "name" | "mode" | "useWorktree">>) => void;
  onDelete: (id: string) => void;
  onCreate: (name: string, mode: GroupMode) => void;
}) {
  const [confirmDel, setConfirmDel] = useState<Group | null>(null);
  const [newName, setNewName] = useState("");
  const count = (id: string) => tasks.filter((t) => t.groupId === id).length;
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
            <div key={g.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2">
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
              <button
                onClick={() => onUpdate(g.id, { useWorktree: !g.useWorktree })}
                className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-muted"
                title="每个任务在独立 git worktree 中运行"
              >
                <span className={`relative h-4 w-7 rounded-full transition-colors ${g.useWorktree ? "bg-accent" : "bg-line2"}`}>
                  <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-panel transition-all ${g.useWorktree ? "left-3.5" : "left-0.5"}`} />
                </span>
                worktree
              </button>
              <span className="shrink-0 text-[12px] text-faint">{count(g.id)} 个任务</span>
              {g.paused ? (
                <>
                  <span className="ml-auto shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">已暂停</span>
                  <button
                    onClick={() => onRun(g.id)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-fg hover:bg-accent-hover"
                    title="继续：恢复运行未开始的任务"
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
                    title="暂停：未开始的任务先挂起，运行中的不打断；再点「运行/继续」恢复"
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
