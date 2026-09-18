import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, CircleNotch, Play, Scroll, Square, TerminalWindow } from "@phosphor-icons/react";
import type { ProjectView } from "@ash/shared";
import { api, type TerminalSessionInfo } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { ProjectAvatar } from "./ProjectAvatar.tsx";

// 全局状态栏(方案 B):横贯窗口底部的一条 app 级栏,项目级「运行现场」的常显面 ——
// 常用命令的启停/重启住在这里,不挤进任务尺度的 inspector 或任务顶栏。
//
// 任务模式(G T)下没有「当前项目」这个概念,所以「运行中 N」的数**永远是跨项目总和**
// (吃 /terminal-commands 全局端点),单项目场景自然塌成一组;左侧上下文段跟随
// currentProject —— 它在任务模式下的语义是「终端/git/新建任务落在哪」,跟着选中任务走
// (WorkspaceShell 的既有定义),这里不另发明规则。
//
// 权限跟终端同一道门:常用命令是任意 shell,多人模式只有实例管理员看得到这一段
// (canUseTerminal),后端 403 兜底。

const POLL_MS = 15_000;

type CommandRow = {
  projectId: string;
  projectName: string;
  commandId: string;
  name: string;
  command: string;
  /** null = 没跑过也没退出记录(纯配置行)。 */
  session: TerminalSessionInfo | null;
  /** 只有锚定项目的行有完整配置(能启动);其他项目只有运行中的会话行。 */
  startable: boolean;
};

function rowsOf(current: ProjectView | null, sessions: TerminalSessionInfo[], projects: ProjectView[]): CommandRow[] {
  const nameOf = (projectId: string) => projects.find((p) => p.id === projectId)?.name ?? "未知项目";
  const rows: CommandRow[] = [];
  const seen = new Set<string>();
  // 同一条命令可能挂着「一条活会话」或「一条刚退出的」——弹层一行只说一件事,活的优先。
  // 判「活」用 groupAlive:组长退了但后台子进程还在(daemonize)也算活,那正是要能停的现场。
  const bestSession = (projectId: string, commandId: string) => {
    const mine = sessions.filter((s) => s.projectId === projectId && s.commandId === commandId);
    return mine.find((s) => s.groupAlive) ?? mine.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  };
  for (const command of current?.commandsConfig ?? []) {
    seen.add(`${current!.id}:${command.id}`);
    rows.push({
      projectId: current!.id,
      projectName: current!.name,
      commandId: command.id,
      name: command.name,
      command: command.command,
      session: bestSession(current!.id, command.id),
      startable: true,
    });
  }
  for (const session of sessions) {
    // 其他项目只列**还活着**的:这一段的全部意义是「别的项目有服务在跑、给你一个停止按钮」,
    // 已退出的会话在没有锚定项目上下文时既没法重启也没必要展示。
    if (session.commandId === null || !session.groupAlive || seen.has(`${session.projectId}:${session.commandId}`)) continue;
    seen.add(`${session.projectId}:${session.commandId}`);
    rows.push({
      projectId: session.projectId,
      projectName: nameOf(session.projectId),
      commandId: session.commandId,
      name: session.name,
      command: "",
      session,
      startable: false,
    });
  }
  return rows;
}

export function StatusBar({
  projects,
  currentProject,
  taskMode,
  canUseTerminal,
  connected,
  terminalOpen,
  onToggleTerminal,
  onOpenCommandLog,
  onManageCommands,
  notify,
}: {
  projects: ProjectView[];
  currentProject: ProjectView | null;
  taskMode: boolean;
  canUseTerminal: boolean;
  connected: boolean;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  /** 打开终端抽屉并聚焦这条命令会话的 tab(只对锚定项目的会话可用)。 */
  onOpenCommandLog: (sessionId: string) => void;
  onManageCommands: () => void;
  notify: (message: string) => void;
}) {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismissable({ enabled: open, containerRef: root, onClose: () => setOpen(false), restoreFocusRef: trigger });

  const refresh = useCallback(() => {
    if (!canUseTerminal) return;
    api.listCommandSessions()
      .then((result) => setSessions(result.sessions))
      .catch(() => undefined); // 状态栏的轮询失败不打扰人,下一轮再试
  }, [canUseTerminal]);

  useEffect(() => {
    if (!canUseTerminal) return;
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [canUseTerminal, refresh]);
  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  // 「运行中 N」和每行的「活/死」都看 groupAlive,不看 exitCode:daemonize 形状
  // (启动脚本把服务放后台后自己退出)下组长退了、服务还在跑,那也是在跑。
  const live = sessions.filter((session) => session.groupAlive);
  const rows = rowsOf(currentProject, sessions, projects);
  const anchorRows = rows.filter((row) => row.startable);
  const otherRows = rows.filter((row) => !row.startable);

  const rowState = (row: CommandRow): { tone: string; text: string } => {
    if (row.session?.groupAlive) {
      return row.session.exitCode === null
        ? { tone: "on", text: "运行中" }
        : { tone: "on", text: "运行中（启动脚本已退出）" };
    }
    if (row.session) {
      // 用户自己点的停止不是异常 —— 哪怕进程死于信号带回非零退出码。
      if (row.session.stoppedByUser) return { tone: "off", text: "已停止" };
      return row.session.exitCode === 0
        ? { tone: "off", text: "已退出" }
        : { tone: "err", text: `已退出（${row.session.exitCode}）` };
    }
    return { tone: "off", text: "未启动" };
  };
  // 红点口径 = 弹层里实际显示的行:锚定项目的某条命令处于异常退出态才亮。跟弹层同一个
  // rowState 算出来,天然不会出现「点亮了却找不到哪行红」。
  const crashed = anchorRows.some((row) => rowState(row).tone === "err");

  const act = (row: CommandRow, action: "start" | "stop" | "restart") => {
    const key = `${row.projectId}:${row.commandId}`;
    setBusy(key);
    const call = action === "start"
      ? api.startProjectCommand(row.projectId, row.commandId)
      : action === "stop"
        ? api.stopProjectCommand(row.projectId, row.commandId)
        : api.restartProjectCommand(row.projectId, row.commandId);
    call
      .then(() => refresh())
      .catch((error) => notify(error instanceof Error ? error.message : `${row.name} 操作失败`))
      .finally(() => setBusy((value) => value === key ? null : value));
  };

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

      {canUseTerminal && (
        <div className="status-bar__run-host" ref={root}>
          <button
            ref={trigger}
            type="button"
            className={`status-bar__item status-bar__run${live.length ? " is-live" : ""}${crashed ? " has-crash" : ""}`}
            aria-expanded={open}
            aria-haspopup="dialog"
            onClick={() => setOpen((value) => !value)}
          >
            <span className={`status-bar__dot${live.length ? " is-on" : ""}`} aria-hidden="true" />
            {live.length ? `运行中 ${live.length}` : "常用命令"}
            {crashed && <span className="status-bar__crash-dot" role="img" aria-label="有命令异常退出" />}
          </button>
          {open && (
            <div className="status-bar__pop" role="dialog" aria-label="常用命令">
              {anchorRows.length === 0 && otherRows.length === 0 && (
                <p className="status-bar__empty">
                  这个项目还没配置常用命令 —— dev server、watch 这类常驻服务配置好后，在这里一键启停。
                </p>
              )}
              {anchorRows.length > 0 && (
                <section>
                  <h3>{currentProject?.name}</h3>
                  {anchorRows.map((row) => {
                    const state = rowState(row);
                    const key = `${row.projectId}:${row.commandId}`;
                    const running = row.session?.groupAlive ? row.session : null;
                    return (
                      <div className="status-bar__row" key={key}>
                        <span className={`status-bar__row-dot is-${state.tone}`} aria-hidden="true" />
                        <div className="status-bar__row-main">
                          <b>{row.name}</b>
                          <code>{row.command}</code>
                        </div>
                        <span className={`status-bar__row-state is-${state.tone}`}>{state.text}</span>
                        <div className="status-bar__row-actions">
                          {busy === key ? <CircleNotch size={13} className="is-spinning" aria-label="执行中" /> : running ? (
                            <>
                              <button type="button" onClick={() => { setOpen(false); onOpenCommandLog(running.id); }} aria-label={`查看 ${row.name} 日志`}><Scroll size={13} />日志</button>
                              <button type="button" onClick={() => act(row, "restart")} aria-label={`重启 ${row.name}`}><ArrowsClockwise size={13} />重启</button>
                              <button type="button" className="is-danger" onClick={() => act(row, "stop")} aria-label={`停止 ${row.name}`}><Square size={12} weight="fill" />停止</button>
                            </>
                          ) : (
                            <>
                              {row.session && <button type="button" onClick={() => { setOpen(false); onOpenCommandLog(row.session!.id); }} aria-label={`查看 ${row.name} 退出日志`}><Scroll size={13} />日志</button>}
                              <button type="button" className="is-primary" onClick={() => act(row, "start")} aria-label={`启动 ${row.name}`}><Play size={12} weight="fill" />启动</button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </section>
              )}
              {otherRows.length > 0 && (
                <section>
                  <h3>其他项目在跑的</h3>
                  {otherRows.map((row) => {
                    const key = `${row.projectId}:${row.commandId}`;
                    return (
                      <div className="status-bar__row" key={key}>
                        <span className="status-bar__row-dot is-on" aria-hidden="true" />
                        <div className="status-bar__row-main">
                          <b>{row.name}</b>
                          <code>{row.projectName} · 日志在该项目的终端里看</code>
                        </div>
                        <div className="status-bar__row-actions">
                          {busy === key
                            ? <CircleNotch size={13} className="is-spinning" aria-label="执行中" />
                            : <button type="button" className="is-danger" onClick={() => act(row, "stop")} aria-label={`停止 ${row.name}`}><Square size={12} weight="fill" />停止</button>}
                        </div>
                      </div>
                    );
                  })}
                </section>
              )}
              {currentProject && currentProject.myRole === "admin" && (
                <button type="button" className="status-bar__manage" onClick={() => { setOpen(false); onManageCommands(); }}>
                  管理常用命令…
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {canUseTerminal && currentProject && (
        <button
          type="button"
          className={`status-bar__item${terminalOpen ? " is-active" : ""}`}
          aria-pressed={terminalOpen}
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
