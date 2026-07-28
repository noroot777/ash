import { GitBranch } from "@phosphor-icons/react";

export function TaskWorktreeChip({ cleaned = false }: { cleaned?: boolean }) {
  const title = cleaned
    ? "验收完成后，任务 worktree 与 harness 分支已清理"
    : "此任务在独立 git worktree 中运行";

  return (
    <span
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded ${
        cleaned ? "text-muted" : "bg-emerald-500/10 text-emerald-600"
      }`}
      title={title}
      aria-label={title}
    >
      <GitBranch
        size={13}
        weight={cleaned ? "regular" : "bold"}
        aria-hidden
        className="pointer-events-none"
      />
    </span>
  );
}
