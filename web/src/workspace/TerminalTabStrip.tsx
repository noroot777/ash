import { useEffect, useRef } from "react";
import { Plus, X } from "@phosphor-icons/react";
import type { TerminalStatus } from "./terminalTabs.ts";
import type { TerminalDock } from "./useTerminalDock.ts";

function statusLabel(status: TerminalStatus): string {
  return status === "starting" ? "正在启动"
    : status === "ready" ? "已连接"
      : status === "reconnecting" ? "正在重连"
        : status === "detached" ? "服务运行中（启动脚本已退出）"
          : status === "ended" ? "已退出"
            : "连接失败";
}

export function TerminalTabStrip({
  ariaLabel,
  className = "",
  dock,
  idPrefix,
}: {
  ariaLabel: string;
  className?: string;
  dock: TerminalDock;
  idPrefix: string;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const { activeId, open: drawerOpen, tabs } = dock;

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, drawerOpen, tabs.length]);

  return (
    <div className={`status-bar__tabs ${className}`.trim()} role="group" aria-label={ariaLabel} ref={strip}>
      {tabs.map((tab) => (
        <span
          className={`status-bar__tab${tab.id === activeId ? " is-current" : ""}${tab.id === activeId && drawerOpen ? " is-active" : ""}`}
          data-active={tab.id === activeId ? "true" : undefined}
          key={tab.id}
        >
          <button
            type="button"
            className="status-bar__tab-open"
            id={`${idPrefix}-${tab.id}`}
            aria-pressed={tab.id === activeId && drawerOpen}
            aria-label={`${tab.label}（${statusLabel(tab.status)}）`}
            onClick={() => dock.select(tab.id)}
          >
            <span className={`status-bar__tab-dot is-${tab.status}`} aria-hidden="true" />
            <b>{tab.label}</b>
          </button>
          <button
            type="button"
            className="status-bar__tab-close"
            aria-label={tab.kind === "command" ? `收起 ${tab.label}（服务继续跑）` : `关闭 ${tab.label}（结束会话）`}
            onClick={() => dock.close(tab.id)}
          ><X size={11} /></button>
        </span>
      ))}
      <button type="button" className="status-bar__tab-add" aria-label="新建 CLI" onClick={dock.add}>
        <Plus size={12} />
      </button>
    </div>
  );
}
