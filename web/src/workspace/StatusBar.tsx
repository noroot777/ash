import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, CircleNotch, Play, Scroll, Square, TerminalWindow } from "@phosphor-icons/react";
import type { ProjectView } from "@ash/shared";
import { parseCommandPlaceholders, SERVICE_COMMAND_ID } from "@ash/shared/project-commands";
import { api, type TerminalSessionInfo } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { CommandArgsDialog } from "./CommandArgsDialog.tsx";
import { COMMANDS_SHORTCUT_LABEL, TERMINAL_SHORTCUT_LABEL } from "./goChord.ts";

// 全局状态栏(方案 B):横贯窗口底部的一条 app 级栏,项目级「运行现场」的常显面 ——
// 常用命令的启停/重启住在这里,不挤进任务尺度的 inspector 或任务顶栏。
//
// 弹层分三段:头部 = 项目 + **service(启动/重启)的 ▶/⟳ 图标按钮**(项目级一对,
// 没配置就置灰 —— 用户点名要独立按钮,不当普通命令摆一行);正文 = 普通常用命令的
// 行列表;底部 = 管理入口。快捷键 G C 开合弹层、G Z 开合终端(workspace/goChord.ts),
// G C 由 openSignal 从外面递进来 —— 弹层的开合状态住在这里,快捷键的分发住在
// useWorkspaceShortcuts,两边用一个递增序号说话。
//
// 任务模式(G T)下没有「当前项目」这个概念,所以「运行中 N」的数**永远是跨项目总和**
// (吃 /terminal-commands 全局端点),单项目场景自然塌成一组;左侧上下文段跟随
// currentProject —— 它在任务模式下的语义是「终端/git/新建任务落在哪」,跟着选中任务走
// (WorkspaceShell 的既有定义),这里不另发明规则。
//
// 命令正文里可以带 `{{占位符}}`:点执行/重启时先弹 CommandArgsDialog 收值,再把**取值**
// 送给后端替换(服务端才是真相,见 server/src/terminal-commands.ts)。没有占位符的命令
// 一如既往点了就跑,不多一次点击。
//
// 权限跟终端同一道门:常用命令是任意 shell,多人模式只有实例管理员看得到这一段
// (canUseTerminal),后端 403 兜底。

const POLL_MS = 15_000;

/** 一次启停打在哪条命令上(弹层头部的 service 和行列表共用同一套动作)。 */
type CommandTarget = { projectId: string; commandId: string; name: string };

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

// 同一条命令可能挂着「一条活会话」或「一条刚退出的」——一处只说一件事,活的优先。
// 判「活」用 groupAlive:组长退了但后台子进程还在(daemonize)也算活,那正是要能停的现场。
function bestSession(sessions: TerminalSessionInfo[], projectId: string, commandId: string): TerminalSessionInfo | null {
  const mine = sessions.filter((s) => s.projectId === projectId && s.commandId === commandId);
  return mine.find((s) => s.groupAlive) ?? mine.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

/** 命令可能是整段多行脚本,行里只摆得下一行:首行 + 还有几行,细节去设置里看。 */
function commandSummary(script: string): string {
  const lines = script.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? "";
  return `${lines[0]} … 共 ${lines.length} 行`;
}

/**
 * 会话事实 → 状态点/文案。service 头部和普通命令行共用,口径才不会劈叉。
 * text 为 null = **没什么可说**:从没跑过的命令旁边就摆着「执行」按钮、点也是灰的,
 * 再写一句「未启动」是把默认态当事件播报(用户 2026-09-18 点名删掉)。
 */
function sessionState(session: TerminalSessionInfo | null): { tone: string; text: string | null } {
  if (session?.groupAlive) {
    return session.exitCode === null
      ? { tone: "on", text: "运行中" }
      : { tone: "on", text: "运行中（启动脚本已退出）" };
  }
  if (session) {
    // 用户自己点的停止不是异常 —— 哪怕进程死于信号带回非零退出码。
    if (session.stoppedByUser) return { tone: "off", text: "已停止" };
    return session.exitCode === 0
      ? { tone: "off", text: "已退出" }
      : { tone: "err", text: `已退出（${session.exitCode}）` };
  }
  return { tone: "off", text: null };
}

function rowsOf(current: ProjectView | null, sessions: TerminalSessionInfo[], projects: ProjectView[]): CommandRow[] {
  const nameOf = (projectId: string) => projects.find((p) => p.id === projectId)?.name ?? "未知项目";
  const rows: CommandRow[] = [];
  const seen = new Set<string>();
  for (const command of current?.commandsConfig?.commands ?? []) {
    seen.add(`${current!.id}:${command.id}`);
    rows.push({
      projectId: current!.id,
      projectName: current!.name,
      commandId: command.id,
      name: command.name,
      command: command.command,
      session: bestSession(sessions, current!.id, command.id),
      startable: true,
    });
  }
  // 锚定项目的 service 会话由弹层头部的 ▶/⟳ 代表,不再挤进行列表。
  if (current) seen.add(`${current.id}:${SERVICE_COMMAND_ID}`);
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
  openSignal,
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
  /** 递增序号,变一次 = 快捷键 G C 按了一下:开合常用命令弹层。0 = 还没按过。 */
  openSignal?: number;
  onToggleTerminal: () => void;
  /** 打开终端抽屉并聚焦这条命令会话的 tab(只对锚定项目的会话可用)。 */
  onOpenCommandLog: (sessionId: string) => void;
  onManageCommands: () => void;
  notify: (message: string) => void;
}) {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** 带占位符的命令:点了执行但还没填完值的那一次。 */
  const [pendingRun, setPendingRun] = useState<{
    target: CommandTarget;
    action: "start" | "restart";
    script: string;
  } | null>(null);
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
  // G C:每按一下序号加一,这里开合一次。初始 0 = 没按过,别在挂载时误触发。
  useEffect(() => {
    if (!openSignal) return;
    setOpen((value) => !value);
  }, [openSignal]);

  // 「运行中 N」和每行的「活/死」都看 groupAlive,不看 exitCode:daemonize 形状
  // (启动脚本把服务放后台后自己退出)下组长退了、服务还在跑,那也是在跑。
  const live = sessions.filter((session) => session.groupAlive);
  const rows = rowsOf(currentProject, sessions, projects);
  const anchorRows = rows.filter((row) => row.startable);
  const otherRows = rows.filter((row) => !row.startable);

  // 项目级「启动/重启」(service):配置在 commandsConfig.service,会话身份是保留
  // commandId "service"。置灰只由**配置**决定(没配置就灰 —— 这正是用户要的「没设置就
  // 灰掉」);重启不要求服务在跑:后端冷态 restart 用 restartCommand ?? command 直接起
  // 新会话(server/src/terminal-commands.ts),`expo start -c` 这类清缓存启动冷态点重启
  // 是合法且常用的路径(第 1 轮逻辑审查)。
  const serviceConfig = currentProject?.commandsConfig?.service ?? null;
  const serviceSession = currentProject ? bestSession(sessions, currentProject.id, SERVICE_COMMAND_ID) : null;
  const serviceLive = serviceSession?.groupAlive ? serviceSession : null;
  const serviceTarget = currentProject
    ? { projectId: currentProject.id, commandId: SERVICE_COMMAND_ID, name: "服务" }
    : null;
  const serviceKey = currentProject ? `${currentProject.id}:${SERVICE_COMMAND_ID}` : "";
  const serviceState = serviceConfig || serviceSession ? sessionState(serviceSession) : null;

  const rowState = (row: CommandRow) => sessionState(row.session);
  // 红点口径 = 弹层里实际显示的现场:锚定项目的 service 或某条命令处于异常退出态才亮。
  // 跟弹层同一个 sessionState 算出来,天然不会出现「点亮了却找不到哪行红」。
  const crashed = anchorRows.some((row) => rowState(row).tone === "err")
    || (serviceState?.tone === "err");

  const act = (target: CommandTarget, action: "start" | "stop" | "restart", values: Record<string, string> = {}) => {
    const key = `${target.projectId}:${target.commandId}`;
    setBusy(key);
    const call: Promise<{ session?: TerminalSessionInfo; stopped?: boolean }> = action === "start"
      ? api.startProjectCommand(target.projectId, target.commandId, values)
      : action === "stop"
        ? api.stopProjectCommand(target.projectId, target.commandId)
        : api.restartProjectCommand(target.projectId, target.commandId, values);
    call
      .then((result) => {
        refresh();
        // 启动/重启成功就把日志直接摆到眼前:关弹层、开终端抽屉并聚焦这条会话的 tab
        // (VSCode 跑任务的习惯 —— 点了「执行」却要自己再去找日志,等于没执行完这个动作)。
        // 只对锚定项目做:别的项目的会话在这个抽屉里没有落点。stop 没有新现场,留在弹层。
        if (action !== "stop" && result.session && result.session.projectId === currentProject?.id) {
          setOpen(false);
          onOpenCommandLog(result.session.id);
        }
      })
      .catch((error) => notify(error instanceof Error ? error.message : `${target.name} 操作失败`))
      .finally(() => setBusy((value) => value === key ? null : value));
  };

  /**
   * 点执行的统一入口:命令里有占位符就先开框收值(填好再 act),没有就直接跑 ——
   * 不给无占位符的命令平白加一次点击。script 传的是**这次真正会跑的那段**
   * (service 重启跑的是 restartCommand),否则框里问的占位符跟实际跑的对不上。
   */
  const requestRun = (target: CommandTarget, action: "start" | "restart", script: string) => {
    if (!parseCommandPlaceholders(script).length) { act(target, action, {}); return; }
    setPendingRun({ target, action, script });
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
            aria-keyshortcuts="g c"
            onClick={() => setOpen((value) => !value)}
          >
            <span className={`status-bar__dot${live.length ? " is-on" : ""}`} aria-hidden="true" />
            {live.length ? `运行中 ${live.length}` : "常用命令"}
            {crashed && <span className="status-bar__crash-dot" role="img" aria-label="有命令异常退出" />}
          </button>
          {open && (
            <div className="status-bar__pop" role="dialog" aria-label="常用命令">
              {currentProject && (
                <header className="status-bar__pop-head">
                  <ProjectAvatar project={currentProject} size="dot" />
                  <h3>{currentProject.name}</h3>
                  {serviceConfig || serviceSession
                    ? serviceState?.text && <span className={`status-bar__svc-state is-${serviceState.tone}`}>{serviceState.text}</span>
                    : <span className="status-bar__svc-state is-unset">未配置启动命令</span>}
                  <div className="status-bar__svc" role="group" aria-label="启动 / 重启">
                    {busy === serviceKey ? <CircleNotch size={14} className="is-spinning" aria-label="执行中" /> : (
                      <>
                        {serviceLive && (
                          <button
                            type="button"
                            className="status-bar__svc-btn"
                            aria-label="查看启动日志"
                            onClick={() => { setOpen(false); onOpenCommandLog(serviceLive.id); }}
                          ><Scroll size={14} /></button>
                        )}
                        {serviceLive ? (
                          <button
                            type="button"
                            className="status-bar__svc-btn is-stop"
                            aria-label="停止"
                            onClick={() => serviceTarget && act(serviceTarget, "stop")}
                          ><Square size={11} weight="fill" /></button>
                        ) : (
                          <button
                            type="button"
                            className="status-bar__svc-btn"
                            aria-label={serviceConfig ? "启动" : "未配置启动命令，在「管理常用命令」里设置"}
                            disabled={!serviceConfig}
                            onClick={() => serviceTarget && serviceConfig && requestRun(serviceTarget, "start", serviceConfig.command)}
                          ><Play size={14} /></button>
                        )}
                        <button
                          type="button"
                          className="status-bar__svc-btn"
                          aria-label={serviceConfig ? "重启" : "未配置启动命令，在「管理常用命令」里设置"}
                          disabled={!serviceConfig}
                          onClick={() => serviceTarget && serviceConfig && requestRun(serviceTarget, "restart", serviceConfig.restartCommand ?? serviceConfig.command)}
                        ><ArrowsClockwise size={13} /></button>
                      </>
                    )}
                  </div>
                </header>
              )}
              <div className="status-bar__pop-body">
                {anchorRows.length === 0 && otherRows.length === 0 && (
                  <p className="status-bar__empty">
                    dev server 这类常驻服务：在「管理常用命令」里配置启动/重启命令后，上面的 ▶ / ⟳ 一键启停；
                    watch、tunnel 这些再各配一条常用命令，在这里逐条启停。
                  </p>
                )}
                {anchorRows.length > 0 && (
                  <section className="status-bar__group" aria-label="常用命令">
                    {anchorRows.map((row) => {
                      const state = rowState(row);
                      const key = `${row.projectId}:${row.commandId}`;
                      const running = row.session?.groupAlive ? row.session : null;
                      return (
                        <div className="status-bar__row" key={key}>
                          <span className={`status-bar__row-dot is-${state.tone}`} aria-hidden="true" />
                          <div className="status-bar__row-main">
                            <b>{row.name}</b>
                            <code>{commandSummary(row.command)}</code>
                          </div>
                          {state.text && <span className={`status-bar__row-state is-${state.tone}`}>{state.text}</span>}
                          <div className="status-bar__row-actions">
                            {busy === key ? <CircleNotch size={13} className="is-spinning" aria-label="执行中" /> : running ? (
                              <>
                                <button type="button" onClick={() => { setOpen(false); onOpenCommandLog(running.id); }} aria-label={`查看 ${row.name} 日志`}><Scroll size={13} />日志</button>
                                <button type="button" onClick={() => requestRun(row, "restart", row.command)} aria-label={`重启 ${row.name}`}><ArrowsClockwise size={13} />重启</button>
                                <button type="button" className="is-danger" onClick={() => act(row, "stop")} aria-label={`停止 ${row.name}`}><Square size={12} weight="fill" />停止</button>
                              </>
                            ) : (
                              <>
                                {row.session && <button type="button" onClick={() => { setOpen(false); onOpenCommandLog(row.session!.id); }} aria-label={`查看 ${row.name} 退出日志`}><Scroll size={13} />日志</button>}
                                <button type="button" className="is-primary" onClick={() => requestRun(row, "start", row.command)} aria-label={`执行 ${row.name}`}><Play size={12} weight="fill" />执行</button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </section>
                )}
                {otherRows.length > 0 && (
                  <section className="status-bar__group">
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
              </div>
              {currentProject && currentProject.myRole === "admin" && (
                <div className="status-bar__pop-foot">
                  <button type="button" className="status-bar__manage" onClick={() => { setOpen(false); onManageCommands(); }}>
                    管理常用命令…
                  </button>
                  <kbd aria-label={`快捷键 ${COMMANDS_SHORTCUT_LABEL}`}>{COMMANDS_SHORTCUT_LABEL}</kbd>
                </div>
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

      {pendingRun && (
        <CommandArgsDialog
          commandName={pendingRun.target.name}
          actionLabel={pendingRun.action === "restart" ? "重启"
            : pendingRun.target.commandId === SERVICE_COMMAND_ID ? "启动" : "执行"}
          script={pendingRun.script}
          rememberKey={`${pendingRun.target.projectId}:${pendingRun.target.commandId}`}
          busy={busy === `${pendingRun.target.projectId}:${pendingRun.target.commandId}`}
          onRun={(values) => { setPendingRun(null); act(pendingRun.target, pendingRun.action, values); }}
          onClose={() => setPendingRun(null)}
        />
      )}
    </footer>
  );
}
