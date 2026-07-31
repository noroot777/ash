import { useEffect, useRef } from "react";
import { Plus, X } from "@phosphor-icons/react";
import { Menu } from "../Menu";
import { useInspector } from "./InspectorContext";
import {
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
} from "./types";

export function InspectorHost() {
  const inspector = useInspector();
  if (!inspector.shown || !inspector.activeDescriptor) return null;

  return (
    <aside
      style={{ width: inspector.state.width }}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-line bg-panel"
      aria-label="Inspector 侧边栏"
    >
      <InspectorResizeHandle width={inspector.state.width} onChange={inspector.setWidth} />
      <div className="flex h-10 shrink-0 items-stretch border-b border-line bg-panel">
        <div role="tablist" aria-label="已打开的 Inspector" className="flex min-w-0 flex-1 overflow-x-auto">
          {inspector.openDescriptors.map((descriptor) => {
            const active = descriptor.id === inspector.activeDescriptor?.id;
            return (
              <div
                key={descriptor.id}
                className={`group/tab relative flex min-w-[92px] max-w-[180px] shrink-0 items-stretch border-r border-line ${active ? "bg-raised/70" : "hover:bg-raised/40"}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => inspector.activate(descriptor.id)}
                  className={`flex min-w-0 flex-1 items-center gap-1.5 border-b-2 pl-3 pr-7 text-left text-[12px] font-medium transition-colors ${active ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}
                >
                  <span className="shrink-0 text-faint">{descriptor.icon}</span>
                  <span className="truncate">{descriptor.title}</span>
                </button>
                <button
                  type="button"
                  aria-label={`关闭 ${descriptor.title}`}
                  onClick={() => inspector.close(descriptor.id)}
                  className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-faint opacity-0 transition group-hover/tab:opacity-100 hover:bg-overlay hover:text-ink focus:opacity-100"
                >
                  <X size={11} weight="bold" />
                </button>
              </div>
            );
          })}
        </div>
        {inspector.unopenedDescriptors.length > 0 ? (
          <Menu
            options={inspector.unopenedDescriptors.map((descriptor) => ({
              value: descriptor.id,
              label: descriptor.title,
              detail: descriptor.description,
              icon: descriptor.icon,
            }))}
            onChange={inspector.open}
            align="right"
            menuWidth={220}
            triggerClassName="grid w-10 shrink-0 place-items-center border-l border-line text-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <Plus size={15} weight="bold" />
            <span className="sr-only">打开 Inspector</span>
          </Menu>
        ) : (
          <button
            type="button"
            disabled
            aria-label="没有可打开的 Inspector"
            className="grid w-10 shrink-0 place-items-center border-l border-line text-faint opacity-50"
          >
            <Plus size={15} weight="bold" />
          </button>
        )}
      </div>
      <div key={inspector.activeDescriptor.id} role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
        {inspector.activeDescriptor.render()}
      </div>
    </aside>
  );
}

function InspectorResizeHandle({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  const start = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!start.current) return;
      onChange(start.current.width - (event.clientX - start.current.x));
    };
    const stop = () => {
      if (!start.current) return;
      start.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [onChange]);

  return (
    <div
      role="separator"
      aria-label="调整 Inspector 宽度，双击恢复默认宽度"
      aria-orientation="vertical"
      aria-valuemin={INSPECTOR_MIN_WIDTH}
      aria-valuemax={INSPECTOR_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onMouseDown={(event) => {
        event.preventDefault();
        start.current = { x: event.clientX, width };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onDoubleClick={() => onChange(INSPECTOR_DEFAULT_WIDTH)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 10;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onChange(width + step);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onChange(width - step);
        } else if (event.key === "Home") {
          event.preventDefault();
          onChange(INSPECTOR_DEFAULT_WIDTH);
        }
      }}
      className="group absolute inset-y-0 left-0 z-20 w-3 -translate-x-1/2 cursor-col-resize outline-none before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-accent/0 before:transition-colors hover:before:bg-accent/70 focus-visible:before:bg-accent"
    />
  );
}
