import { SidebarSimple } from "@phosphor-icons/react";
import { Tip } from "../Tip";
import { useInspector } from "./InspectorContext";

export function InspectorToggleButton({ className = "" }: { className?: string }) {
  const inspector = useInspector();
  const label = inspector.shown ? "隐藏侧边栏" : "显示侧边栏";
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-pressed={inspector.shown}
        onClick={inspector.toggle}
        disabled={inspector.descriptors.length === 0}
        className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-40 ${inspector.shown ? "bg-raised text-ink" : ""} ${className}`}
      >
        <SidebarSimple size={16} className="rotate-180" />
      </button>
    </Tip>
  );
}
