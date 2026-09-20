import { TerminalWindow } from "@phosphor-icons/react";
import type { ProjectView } from "@ash/shared";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { TERMINAL_SHORTCUT_LABEL } from "./goChord.ts";
import { TerminalTabStrip } from "./TerminalTabStrip.tsx";
import type { TerminalDock } from "./useTerminalDock.ts";

// 全局状态栏(方案 B):横贯窗口底部的一条 app 级栏。剩三段:左边「列表在看谁」的上下文、
// 中间终端(开关 + **开着的那几个终端**)、右边实时连接指示。
//
// 状态栏这份 tab 条在抽屉收起时仍然可见；展开后，抽屉顶栏还会镜像一份同一账本，
// 方便视线停在终端内容附近时直接切换。
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
  terminal,
}: {
  currentProject: ProjectView | null;
  taskMode: boolean;
  canUseTerminal: boolean;
  connected: boolean;
  terminal: TerminalDock;
}) {
  const showTerminal = canUseTerminal && !!currentProject;
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

          <TerminalTabStrip ariaLabel="状态栏中的终端" dock={terminal} idPrefix="status-terminal-tab" />
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
