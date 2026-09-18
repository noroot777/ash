import { TerminalWindow } from "@phosphor-icons/react";
import type { ProjectView } from "@ash/shared";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { TERMINAL_SHORTCUT_LABEL } from "./goChord.ts";

// 全局状态栏(方案 B):横贯窗口底部的一条 app 级栏。剩三段:左边「列表在看谁」的上下文、
// 中间终端开关(G Z)、右边实时连接指示。
//
// **常用命令的启停现场不在这里了** —— 2026-09-18 整条搬到侧栏顶行那颗 ▶
// (workspace/CommandsLauncher.tsx):它是项目级的东西,离项目名和分支胶囊一步远才顺手,
// 摆在窗口最底下等于每次都要横跨整个屏幕。
//
// 终端跟常用命令同一道权限门(canUseTerminal:多人模式只有实例管理员看得到),后端 403 兜底。

export function StatusBar({
  currentProject,
  taskMode,
  canUseTerminal,
  connected,
  terminalOpen,
  onToggleTerminal,
}: {
  currentProject: ProjectView | null;
  taskMode: boolean;
  canUseTerminal: boolean;
  connected: boolean;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
}) {
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

      {canUseTerminal && currentProject && (
        <button
          type="button"
          className={`status-bar__item${terminalOpen ? " is-active" : ""}`}
          aria-pressed={terminalOpen}
          aria-keyshortcuts="g z"
          aria-label={`终端（${TERMINAL_SHORTCUT_LABEL}）`}
          onClick={onToggleTerminal}
        >
          <TerminalWindow size={13} aria-hidden="true" />
          终端
        </button>
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
