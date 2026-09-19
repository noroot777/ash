import { useEffect, useRef } from "react";
import { Plus, TerminalWindow, X } from "@phosphor-icons/react";
import type { ProjectView } from "@ash/shared";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { TERMINAL_SHORTCUT_LABEL } from "./goChord.ts";
import type { TerminalStatus } from "./terminalTabs.ts";
import type { TerminalDock } from "./useTerminalDock.ts";

// 全局状态栏(方案 B):横贯窗口底部的一条 app 级栏。剩三段:左边「列表在看谁」的上下文、
// 中间终端(开关 + **开着的那几个终端**)、右边实时连接指示。
//
// tab 条摆在这里而不是抽屉顶上(用户 2026-09-19 点名):抽屉一收,「还有几个 shell 活着」
// 就彻底没了说法 —— 而会话是持久的,收起只是不看了。摆在状态栏上,收着也一眼看得见,
// 点一下就展开到那一个。账本在 workspace/useTerminalDock.ts,抽屉只剩现场。
//
// **常用命令的启停现场不在这里了** —— 2026-09-18 整条搬到侧栏顶行那颗 ▶
// (workspace/CommandsLauncher.tsx):它是项目级的东西,离项目名和分支胶囊一步远才顺手,
// 摆在窗口最底下等于每次都要横跨整个屏幕。
//
// 终端跟常用命令同一道权限门(canUseTerminal:多人模式只有实例管理员看得到),后端 403 兜底。

function statusLabel(status: TerminalStatus): string {
  return status === "starting" ? "正在启动"
    : status === "ready" ? "已连接"
      : status === "reconnecting" ? "正在重连"
        : status === "detached" ? "服务运行中（启动脚本已退出）"
          : status === "ended" ? "已退出"
            : "连接失败";
}

export function StatusBar({
  currentProject,
  taskMode,
  canUseTerminal,
  connected,
  terminal,
}: {
  currentProject: ProjectView | null;
  taskMode: boolean;
  canUseTerminal: boolean;
  connected: boolean;
  terminal: TerminalDock;
}) {
  const showTerminal = canUseTerminal && !!currentProject;
  // 开得多了 tab 区自己横向滚,那就得保证「当前这个」始终在视野里 —— 从常用命令点「日志」
  // 插进来的新 tab 排在最前面,滚条却可能停在末尾。
  const strip = useRef<HTMLDivElement>(null);
  const { activeId, open: drawerOpen, tabs } = terminal;
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, drawerOpen, tabs.length]);
  return (
    <footer className="status-bar" aria-label="全局状态栏">
      <div className="status-bar__context">
        {taskMode && <span className="status-bar__mode">任务模式</span>}
        {currentProject && (
          <span className="status-bar__project" aria-label={`当前项目 ${currentProject.name}`}>
            <ProjectAvatar project={currentProject} size="dot" />
            <span>{currentProject.name}</span>
          </span>
        )}
      </div>

      {showTerminal && (
        <>
          <button
            type="button"
            className={`status-bar__item${terminal.open ? " is-active" : ""}`}
            aria-pressed={terminal.open}
            aria-keyshortcuts="g z"
            aria-label={`终端（${TERMINAL_SHORTCUT_LABEL}）`}
            onClick={terminal.toggle}
          >
            <TerminalWindow size={13} aria-hidden="true" />
            终端
            {/* 快捷键提示:aria-label 里已经念过一遍,这里纯给眼睛看。 */}
            <kbd className="status-bar__kbd" aria-hidden="true">{TERMINAL_SHORTCUT_LABEL}</kbd>
          </button>

          <div className="status-bar__tabs" role="group" aria-label="开着的终端" ref={strip}>
            {tabs.map((tab) => (
              <span
                className={`status-bar__tab${tab.id === activeId ? " is-current" : ""}${tab.id === activeId && drawerOpen ? " is-active" : ""}`}
                data-active={tab.id === activeId ? "true" : undefined}
                key={tab.id}
              >
                <button
                  type="button"
                  className="status-bar__tab-open"
                  id={`terminal-tab-${tab.id}`}
                  aria-pressed={tab.id === activeId && drawerOpen}
                  aria-label={`${tab.label}（${statusLabel(tab.status)}）`}
                  onClick={() => terminal.select(tab.id)}
                >
                  <span className={`status-bar__tab-dot is-${tab.status}`} aria-hidden="true" />
                  <b>{tab.label}</b>
                </button>
                <button
                  type="button"
                  className="status-bar__tab-close"
                  aria-label={tab.kind === "command" ? `收起 ${tab.label}（服务继续跑）` : `关闭 ${tab.label}（结束会话）`}
                  onClick={() => terminal.close(tab.id)}
                ><X size={11} /></button>
              </span>
            ))}
            <button type="button" className="status-bar__tab-add" aria-label="新建 CLI" onClick={terminal.add}>
              <Plus size={12} />
            </button>
          </div>
        </>
      )}

      <div className="status-bar__right">
        <span className={`status-bar__conn${connected ? " is-on" : ""}`}>
          <span className={`status-bar__dot${connected ? " is-on" : ""}`} aria-hidden="true" />
          {connected ? "已连接" : "连接断开"}
        </span>
      </div>
    </footer>
  );
}
