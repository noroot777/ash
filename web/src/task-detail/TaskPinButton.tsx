import type { Task } from "@ash/shared";
import { PushPinSimple } from "@phosphor-icons/react";
import { IconButton } from "../components/IconButton.tsx";

/**
 * 图钉紧跟标题：置顶了是实心的墨色、一直在；没置顶的平时不画，指到头部或键盘走到它才出来
 * （docs/ui-ux-audit head-2；样式见 controls.css 的 .task-pin）。
 */
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
    <IconButton
      className={`task-pin${pinned ? " is-pinned" : ""}`}
      size="sm"
      label={pinned ? "取消置顶" : "置顶"}
      aria-pressed={pinned}
      onClick={() => {
        void onTogglePin().catch((reason) => {
          notify(reason instanceof Error ? reason.message : String(reason));
        });
      }}
    >
      <PushPinSimple size={14} weight={pinned ? "fill" : "regular"} aria-hidden="true" />
    </IconButton>
  );
}
