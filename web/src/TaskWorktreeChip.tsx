export function TaskWorktreeChip({ cleaned = false }: { cleaned?: boolean }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted"
      title={cleaned ? "验收完成后，任务 worktree 与 harness 分支已清理" : "此任务在独立 git worktree 中运行"}
    >
      {cleaned ? "worktree 已清理" : "worktree"}
    </span>
  );
}
