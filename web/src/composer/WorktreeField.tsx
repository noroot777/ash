import { GitBranch, TreeStructure } from "@phosphor-icons/react";
import { Pill } from "../Menu";

// 「在新 worktree 里跑」开关 + base 分支选择。和 RunLocation 同一视觉层，让用户
// 一眼看清「这次任务跑在哪、用哪个分支」。关闭时只占一行；开启时展开一个紧凑的
// base 选择面板（沿用 Pill / Menu 风格，和正文 Pill 一致）。
export function WorktreeField({
  on,
  base,
  branches,
  taskIdPreview,
  team,
  isGlobalDefault,
  savingDefault,
  onToggle,
  onSetDefault,
  onBase,
}: {
  on: boolean;
  base: string;
  branches: string[];
  taskIdPreview: string;
  team: boolean;
  isGlobalDefault: boolean;
  savingDefault: boolean;
  onToggle: () => void;
  onSetDefault: () => void;
  onBase: (b: string) => void;
}) {
  const baseLabel = base || "当前分支";
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-muted hover:bg-raised hover:text-ink"
        title={on ? "关闭：直接在项目目录跑" : team ? "开启：整支团队在同一个新 worktree 里跑" : "开启：本次任务在新 worktree 里跑"}
      >
        <TreeStructure size={12} className={on ? "text-accent" : "text-faint"} />
        <span>{team ? "团队共用 worktree" : "用 worktree 隔离"}</span>
        <span
          className={`relative ml-0.5 inline-block h-3 w-5 rounded-full transition-colors ${on ? "bg-accent" : "bg-line2"}`}
          aria-pressed={on}
        >
          <span className={`absolute top-0.5 h-2 w-2 rounded-full bg-panel transition-all ${on ? "left-2.5" : "left-0.5"}`} />
        </span>
      </button>
      {!isGlobalDefault && (
        <button
          type="button"
          disabled={savingDefault}
          onClick={onSetDefault}
          className="ml-1 rounded px-1.5 py-0.5 text-[10px] text-faint hover:bg-raised hover:text-ink disabled:opacity-50"
          title="把当前 worktree 选择保存为以后新建任务的默认值"
        >
          {savingDefault ? "保存中…" : "设为默认"}
        </button>
      )}
      {on && (
        <div className="ml-1 mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          <span className="text-faint">base</span>
          <Pill
            icon={<GitBranch size={11} />}
            label={baseLabel}
            value={base}
            onChange={onBase}
            options={[
              { value: "", label: "当前分支（HEAD）" },
              ...branches.map((b) => ({ value: b, label: b })),
            ]}
            menuWidth={220}
          />
          <span className="text-faint">→ 新分支 {taskIdPreview}</span>
        </div>
      )}
    </div>
  );
}
