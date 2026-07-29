import type { Task } from "@harness/shared";
import { DotsThree, PushPin } from "@phosphor-icons/react";
import { Menu } from "./Menu";
import { Tip } from "./Tip";
import { toast } from "./toast";

export function TaskPinMenu({
  task,
  onPatch,
  stopPropagation = false,
}: {
  task: Task;
  onPatch: (patch: Partial<Task>) => void | Promise<void>;
  stopPropagation?: boolean;
}) {
  if (task.archived) return null;
  const pinned = task.pinnedAt != null;
  const label = pinned ? "取消置顶" : "置顶";
  const menu = (
    <Tip label={`更多操作 · ${label}`} className="inline-flex shrink-0">
      <Menu
        align="right"
        menuWidth={156}
        options={[{
          value: "toggle-pin",
          label,
          icon: <PushPin size={14} weight={pinned ? "fill" : "regular"} className={pinned ? "text-accent" : "text-muted"} />,
        }]}
        onChange={() => {
          void Promise.resolve(onPatch({ pinnedAt: pinned ? null : Date.now() })).catch((error) => {
            toast(error instanceof Error ? error.message : String(error));
          });
        }}
        triggerClassName="grid h-6 w-6 place-items-center rounded-md text-faint transition-colors hover:bg-overlay hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <DotsThree size={16} weight="bold" aria-hidden />
        <span className="sr-only">更多任务操作</span>
      </Menu>
    </Tip>
  );
  return stopPropagation ? <span onClick={(event) => event.stopPropagation()}>{menu}</span> : menu;
}

export function TaskPinButton({
  task,
  onPatch,
}: {
  task: Task;
  onPatch: (patch: Partial<Task>) => void | Promise<void>;
}) {
  if (task.archived) return null;
  const pinned = task.pinnedAt != null;
  const label = pinned ? "取消置顶" : "置顶";
  return (
    <button
      type="button"
      onClick={() => {
        void Promise.resolve(onPatch({ pinnedAt: pinned ? null : Date.now() })).catch((error) => {
          toast(error instanceof Error ? error.message : String(error));
        });
      }}
      className="inline-flex h-[30px] items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
    >
      <PushPin size={14} weight={pinned ? "fill" : "regular"} className={pinned ? "text-accent" : undefined} />
      {label}
    </button>
  );
}
