import type { Task } from "@harness/shared";
import { PushPinSimple } from "@phosphor-icons/react";

export function TaskPinButton({
  task,
  onTogglePin,
  notify,
}: {
  task: Task;
  onTogglePin: () => Promise<void>;
  notify: (message: string) => void;
}) {
  if (task.archived) return null;
  const pinned = task.pinnedAt != null;

  return (
    <button
      className={`task-pin${pinned ? " is-pinned" : ""}`}
      type="button"
      aria-label={pinned ? "取消置顶" : "置顶"}
      aria-pressed={pinned}
      title={pinned ? "取消置顶" : "置顶"}
      onClick={() => {
        void onTogglePin().catch((reason) => {
          notify(reason instanceof Error ? reason.message : String(reason));
        });
      }}
    >
      <PushPinSimple size={14} weight={pinned ? "fill" : "regular"} aria-hidden="true" />
    </button>
  );
}
