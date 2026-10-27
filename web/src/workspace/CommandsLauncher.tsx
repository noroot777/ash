import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, CircleNotch, Play, Scroll, Square } from "@phosphor-icons/react";
import type { ProjectView } from "@ash/shared";
import { parseCommandPlaceholders, SERVICE_COMMAND_ID } from "@ash/shared/project-commands";
import { api, type TerminalSessionInfo } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { CommandArgsDialog } from "./CommandArgsDialog.tsx";
import { COMMANDS_SHORTCUT_LABEL } from "./goChord.ts";

// 常用命令的启动入口:侧栏顶行、项目名和分支胶囊右边那颗 ▶。点开是项目级「运行现场」——
// 启停/重启/看日志都在这一个弹层里,不挤进任务尺度的 inspector 或任务顶栏。
// (它从窗口底部的全局状态栏搬上来:那里离项目上下文太远,用户点名要摆在项目头一行。)
//
// 弹层分三段:头部 = 项目 + **service(启动/停止/重启)的图标按钮**(项目级一组,
// 没配置就置灰 —— 用户点名要独立按钮,不当普通命令摆一行);正文 = 普通常用命令的
// 行列表;底部 = 管理入口。服务起着的时候 ▶ **就地**换成红框的停止(用户 2026-10-26
// 点名:同一个位置换一颗按钮,不在旁边另摆一颗),默认停法是杀掉启动会话的整个进程组,
// 项目设置里填了停止命令就改跑那段脚本。
// 快捷键 G C 开合弹层、G Z 开合终端(workspace/goChord.ts),
// G C 由 openSignal 从外面递进来 —— 弹层的开合状态住在这里,快捷键的分发住在
// useWorkspaceShortcuts,两边用一个递增序号说话。**收起侧栏 / 去设置页会把这颗按钮
// 连同组件一起卸载**,所以 openSignal 要按「挂载时那一格」做基准比对,否则重新挂载
// 那一瞬间会被历史信号误开一次。
//
// 这颗按钮**只说当前项目的事**(用户 2026-09-19 点名):别的项目有服务在跑,既不点亮它、
// 也不在弹层里列出来 —— 那些现场在那个项目的状态栏和终端里,摆到这儿只会让人以为是自己
// 这个项目在跑。所以会话事实吃的是项目级端点,跨项目总和连带那个计数徽标一并退役。
// currentProject 在任务模式(G T)下的语义是「终端/git/新建任务落在哪」,跟着选中任务走
// (WorkspaceShell 的既有定义),这里不另发明规则。
//
// 命令正文里可以带 `{{占位符}}`:点执行/重启时先弹 CommandArgsDialog 收值,再把**取值**
// 送给后端替换(服务端才是真相,见 server/src/terminal-commands.ts)。没有占位符的命令
// 一如既往点了就跑,不多一次点击。
//
// 权限跟终端同一道门:常用命令是任意 shell,多人模式只有实例管理员看得到这一段
// (canUseTerminal),后端 403 兜底。

const POLL_MS = 15_000;

/** 会话事实自带「这是哪个项目的」,读的那一侧才认得出晚到的旧事实(见 refresh)。 */
type SessionFact = { projectId: string | null; sessions: TerminalSessionInfo[] };
const NO_FACT: SessionFact = { projectId: null, sessions: [] };

/** 一次启停打在哪条命令上(弹层头部的 service 和行列表共用同一套动作)。 */
type CommandTarget = { projectId: string; commandId: string; name: string };

type CommandRow = {
  projectId: string;
  commandId: string;
  name: string;
  command: string;
  /** null = 没跑过也没退出记录(纯配置行)。 */
  session: TerminalSessionInfo | null;
};

/**
 * 这条会话名下**还有东西在跑吗** —— 弹层里每一个表面(头部按钮、每行的按钮与状态、外面
 * 那颗 ▶ 亮不亮)都认这一个判据,**与服务端的 sessionRunning 逐字对齐**
 * (server/src/terminal.ts):两边劈叉就会出现「停止按钮摆在那儿、点下去什么都没发生」,
 * 或者反过来「服务还听着端口,界面却摆着启动按钮、再点一次起第二份」。
 *
 * 进程归属(groupAlive:组长退了但后台子进程还在的 daemonize 形状也算)之外多两档:
 * ① **它打印过的端口还有人在听**(而且核实是这次启动起来的) —— 真·守护化的服务
 * (双 fork + setsid)从进程归属里全逃了,端口是仅剩的线索;② **上次停止留下了还活着的号**:
 * 端口让出来了,但同组还有核不上归属、没敢杀的进程,那次启动就还没了结,停止按钮得留在那儿
 * 让用户能再按。
 *
 * **只认活证据**:账上那种「一个号都举不出来」的没核销(端口超额,证据本身不全)不进这一问
 * —— 它永远核销不掉,当成「还在跑」就等于这条命令再也起不动了。那句话由 sessionState 去说。
 */
const leftoversOf = (session: TerminalSessionInfo): number[] =>
  session.stop.kind === "unresolved" ? session.stop.pids : [];

const sessionRunning = (session: TerminalSessionInfo): boolean =>
  session.groupAlive || session.portsAlive || leftoversOf(session).length > 0;

// 同一条命令可能挂着「一条活会话」或「一条刚退出的」——一处只说一件事,活的优先。
function bestSession(sessions: TerminalSessionInfo[], projectId: string, commandId: string): TerminalSessionInfo | null {
  const mine = sessions.filter((s) => s.projectId === projectId && s.commandId === commandId);
  return mine.find(sessionRunning) ?? mine.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
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
 *
 * open = 会话已经退了,但我们仍认为服务开着(端口还有人听,或配了停止命令;见 serviceOpen)。
 * 这时说「已退出」是错的 —— 退的是启动脚本,服务在 ash 的进程树之外跑着。
 *
 * service = 这是项目级服务那一行。它正常退出时只说「启动脚本已退出」而不说「已退出」:
 * ash 知道的只有**脚本**退了,服务是不是真停了它并不知道(守护化的服务既没留进程、这次又
 * 没打印端口时,谁也说不准)。普通命令不走这一档 —— `npm run build` 退了就是退了。
 */
function sessionState(
  session: TerminalSessionInfo | null,
  open = false,
  service = false,
): { tone: string; text: string | null } {
  if (session && sessionRunning(session)) {
    // 监听已经让出来了、只剩几个没能收掉的号:既不是「运行中」也不是「已停止」,照实说第三种
    // (第 2 轮审查发现 2 —— 这一档以前被静默并进「已停止」)。
    // **不在这儿写成因**:账上这几个号有两种来路 —— 核不上归属所以没敢动的,以及核实是这次
    // 起来的、却连 KILL 都没停下来的(第 6 轮审查 F1 之后后者也会进账)。前端只拿到号码,
    // 分不出是哪一种;成因在服务端那句 `why` 里逐个说清,这里只报个数。
    if (!session.groupAlive && !session.portsAlive) {
      return { tone: "on", text: `停止未完成（还剩 ${leftoversOf(session).length} 个进程没能收掉）` };
    }
    return session.exitCode === null
      ? { tone: "on", text: "运行中" }
      : { tone: "on", text: "运行中（启动脚本已退出）" };
  }
  if (session) {
    if (open) return { tone: "on", text: "已启动" };
    // 没有活证据了,但那次停止**没能证明停净**(端口超额:没记下的端口谁都没问过,或者
    // 当时核不上归属的号后来才自己退掉)。「已停止」是谎报,这一句得留着 —— 刷新回来也在
    // (根 AGENTS.md:停止要留下持久可见的状态;第 3 轮审查发现 1:这一档以前一个 PID
    // 都举不出来,于是被整条读成「干净」)。
    if (session.stop.kind === "unresolved") return { tone: "err", text: "已停止（没能确认停净）" };
    // 用户自己点的停止不是异常 —— 哪怕进程死于信号带回非零退出码。
    if (session.stoppedByUser) return { tone: "off", text: "已停止" };
    if (session.exitCode === 0) return { tone: "off", text: service ? "启动脚本已退出" : "已退出" };
    return { tone: "err", text: `已退出（${session.exitCode}）` };
  }
  return { tone: "off", text: null };
}

function rowsOf(current: ProjectView | null, sessions: TerminalSessionInfo[]): CommandRow[] {
  if (!current) return [];
  // service 会话由弹层头部的 ▶/⟳ 代表,不再挤进行列表。
  return (current.commandsConfig?.commands ?? []).map((command) => ({
    projectId: current.id,
    commandId: command.id,
    name: command.name,
    command: command.command,
    session: bestSession(sessions, current.id, command.id),
  }));
}

export function CommandsLauncher({
  currentProject,
  canUseTerminal,
  collapsed = false,
  openSignal,
  onOpenCommandLog,
  onManageCommands,
  notify,
}: {
  currentProject: ProjectView | null;
  canUseTerminal: boolean;
  /** 侧栏收起时这颗按钮塌成纯图标(和其它 workspace-side-icon 一列)。 */
  collapsed?: boolean;
  /** 递增序号,变一次 = 快捷键 G C 按了一下:开合常用命令弹层。0 = 还没按过。 */
  openSignal?: number;
  /** 打开终端抽屉并聚焦这条命令会话的 tab。 */
  onOpenCommandLog: (session: TerminalSessionInfo) => void;
  onManageCommands: () => void;
  notify: (message: string) => void;
}) {
  const [fact, setFact] = useState<SessionFact>(NO_FACT);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** 带占位符的命令:点了执行但还没填完值的那一次。 */
  const [pendingRun, setPendingRun] = useState<{
    target: CommandTarget;
    action: "start" | "restart";
    script: string;
  } | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // 挂载时把当前信号记成基准:只有**挂载之后**再按的 G C 才算数。
  const seenSignal = useRef(openSignal ?? 0);
  useDismissable({ enabled: open, containerRef: root, onClose: () => setOpen(false), restoreFocusRef: trigger });

  // 只问当前项目,拿回来再按项目和「是不是常用命令」筛一道:交互 shell(commandId 为 null)
  // 不是常用命令,别让它点亮这颗 ▶;projectId 那道是口径的兜底 —— 这颗按钮只说本项目的事。
  //
  // 事实上还要防**晚一步落回来的旧事实**:切项目那一刻上一次 list 可能还在飞(启停成功的
  // .then 里也会再 refresh 一次,它捕获的是切走前那只),落回来就会把上一个项目在跑的服务
  // 记到当前项目头上、点亮这颗按钮。所以结果带着来源项目一起存,读的那一侧只认当前项目的。
  const projectId = currentProject?.id ?? null;
  const sessions = fact.projectId === projectId ? fact.sessions : NO_FACT.sessions;
  const refresh = useCallback(() => {
    if (!canUseTerminal || !projectId) { setFact(NO_FACT); return; }
    api.listTerminalSessions(projectId)
      .then((result) => setFact({
        projectId,
        sessions: result.sessions.filter((session) => session.commandId !== null && session.projectId === projectId),
      }))
      .catch(() => undefined); // 轮询失败不打扰人,下一轮再试
  }, [canUseTerminal, projectId]);

  useEffect(() => {
    if (!canUseTerminal) return;
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [canUseTerminal, refresh]);
  useEffect(() => { if (open) refresh(); }, [open, refresh]);
  // G C:每按一下序号加一,这里开合一次。和挂载基准比,别在重新挂载时误触发。
  useEffect(() => {
    const signal = openSignal ?? 0;
    if (signal === seenSignal.current) return;
    seenSignal.current = signal;
    setOpen((value) => !value);
  }, [openSignal]);

  // 项目级「启动/重启」(service):配置在 commandsConfig.service,会话身份是保留
  // commandId "service"。置灰只由**配置**决定(没配置就灰 —— 这正是用户要的「没设置就
  // 灰掉」);重启不要求服务在跑:后端冷态 restart 用 restartCommand ?? command 直接起
  // 新会话(server/src/terminal-commands.ts),`expo start -c` 这类清缓存启动冷态点重启
  // 是合法且常用的路径(第 1 轮逻辑审查)。
  const serviceConfig = currentProject?.commandsConfig?.service ?? null;
  const serviceSession = currentProject ? bestSession(sessions, currentProject.id, SERVICE_COMMAND_ID) : null;
  // 「服务还开着」——▶ 要不要换成停止看它。**口径与服务端的 openSession 逐字对齐**
  // (server/src/terminal-commands.ts),两边不一致就会出现「按钮在那儿、点下去什么都没发生」。
  // 三档:① 活会话 = 确定在跑;② 启动脚本退了但它打印过的端口还有人听 —— 真·守护化的服务
  // (双 fork + setsid)从进程归属里全逃了,端口是仅剩的线索,顺着它能真杀到,所以这一档
  // **不要求配停止命令**;③ 配了停止命令时,正常退出又没被停过的那次启动也算开着 ——
  // `docker compose up -d` 这类连端口都未必打在本机,那条命令就是用户给的线索。
  const serviceOpen = serviceSession && (sessionRunning(serviceSession)
    || (serviceConfig?.stopCommand && serviceSession.exitCode === 0 && !serviceSession.stoppedByUser))
    ? serviceSession
    : null;
  const serviceTarget = currentProject
    ? { projectId: currentProject.id, commandId: SERVICE_COMMAND_ID, name: "服务" }
    : null;
  const serviceKey = currentProject ? `${currentProject.id}:${SERVICE_COMMAND_ID}` : "";
  const serviceState = serviceConfig || serviceSession ? sessionState(serviceSession, serviceOpen !== null, true) : null;

  // 按钮亮不亮和每行的「活/死」都看 sessionRunning,不看 exitCode:daemonize 形状
  // (启动脚本把服务放后台后自己退出)下组长退了、服务还在跑,那也是在跑;service 另按
  // serviceOpen 算 —— 弹层里说它开着,外面那颗按钮就不该是灰的。
  const live = sessions.some(sessionRunning) || serviceOpen !== null;
  const rows = rowsOf(currentProject, sessions);

  const rowState = (row: CommandRow) => sessionState(row.session);
  // 红点口径 = 弹层里实际显示的现场:锚定项目的 service 或某条命令处于异常退出态才亮。
  // 跟弹层同一个 sessionState 算出来,天然不会出现「点亮了却找不到哪行红」。
  const crashed = rows.some((row) => rowState(row).tone === "err")
    || (serviceState?.tone === "err");

  const act = (target: CommandTarget, action: "start" | "stop" | "restart", values: Record<string, string> = {}) => {
    const key = `${target.projectId}:${target.commandId}`;
    setBusy(key);
    const call: Promise<{ session?: TerminalSessionInfo; stopped?: boolean; notice?: string }> = action === "start"
      ? api.startProjectCommand(target.projectId, target.commandId, values)
      : action === "stop"
        ? api.stopProjectCommand(target.projectId, target.commandId)
        : api.restartProjectCommand(target.projectId, target.commandId, values);
    call
      .then((result) => {
        refresh();
        // 「停下来了,但同组还有几个核不上归属、没敢杀的进程」—— 成功路径上的话,但必须说出来:
        // 咽下去就等于拿「端口让出来了」冒充「这次启动起来的东西都停了」(第 2 轮审查发现 2)。
        if (result.notice) notify(result.notice);
        // 启动/重启成功就把日志直接摆到眼前:关弹层、开终端抽屉并聚焦这条会话的 tab
        // (VSCode 跑任务的习惯 —— 点了「执行」却要自己再去找日志,等于没执行完这个动作)。
        // stop 没有新现场,留在弹层。
        if (action !== "stop" && result.session) {
          setOpen(false);
          onOpenCommandLog(result.session);
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

  if (!canUseTerminal) return null;

  // 计数徽标退役(用户 2026-09-19:「数字也没必要有」)—— 这个项目在不在跑,一个亮/灰就说完了。
  const triggerLabel = `常用命令（${COMMANDS_SHORTCUT_LABEL}）${live ? "，运行中" : ""}`;

  return (
    <span className={`cmd-launcher-host${collapsed ? " is-collapsed" : ""}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`cmd-launcher${live ? " is-live" : ""}${crashed ? " has-crash" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-keyshortcuts="g c"
        aria-label={triggerLabel}
        onClick={() => setOpen((value) => !value)}
      >
        <Play size={13} weight="fill" aria-hidden="true" />
        {crashed && <span className="cmd-launcher__crash" role="img" aria-label="有命令异常退出" />}
      </button>
      {open && (
        <div className="cmd-pop" role="dialog" aria-label="常用命令">
          {currentProject && (
            <header className="cmd-pop__head">
              <ProjectAvatar project={currentProject} size="dot" />
              <h3>{currentProject.name}</h3>
              {serviceConfig || serviceSession
                ? serviceState?.text && <span className={`cmd-pop__svc-state is-${serviceState.tone}`}>{serviceState.text}</span>
                : <span className="cmd-pop__svc-state is-unset">未配置启动命令</span>}
              <div className="cmd-pop__svc" role="group" aria-label="启动 / 停止 / 重启">
                {busy === serviceKey ? <CircleNotch size={14} className="is-spinning" aria-label="执行中" /> : (
                  <>
                    {serviceSession && (
                      <button
                        type="button"
                        className="cmd-pop__svc-btn"
                        aria-label={serviceOpen ? "查看启动日志" : "查看上次启动的日志"}
                        onClick={() => { setOpen(false); onOpenCommandLog(serviceSession); }}
                      ><Scroll size={14} /></button>
                    )}
                    {serviceOpen ? (
                      <button
                        type="button"
                        className="cmd-pop__svc-btn is-stop"
                        aria-label={serviceConfig?.stopCommand ? "停止（跑停止命令）" : "停止"}
                        onClick={() => serviceTarget && act(serviceTarget, "stop")}
                      ><Square size={12} weight="bold" /></button>
                    ) : (
                      <button
                        type="button"
                        className="cmd-pop__svc-btn"
                        aria-label={serviceConfig ? "启动" : "未配置启动命令，在「管理常用命令」里设置"}
                        disabled={!serviceConfig}
                        onClick={() => serviceTarget && serviceConfig && requestRun(serviceTarget, "start", serviceConfig.command)}
                      ><Play size={14} /></button>
                    )}
                    <button
                      type="button"
                      className="cmd-pop__svc-btn"
                      aria-label={serviceConfig ? "重启" : "未配置启动命令，在「管理常用命令」里设置"}
                      disabled={!serviceConfig}
                      onClick={() => serviceTarget && serviceConfig && requestRun(serviceTarget, "restart", serviceConfig.restartCommand ?? serviceConfig.command)}
                    ><ArrowsClockwise size={13} /></button>
                  </>
                )}
              </div>
            </header>
          )}
          <div className="cmd-pop__body">
            {rows.length === 0 && (
              <p className="cmd-pop__empty">
                dev server 这类常驻服务：在「管理常用命令」里配置启动/重启命令后，上面的按钮一键启停
                （服务起着的时候 ▶ 会变成停止）；watch、tunnel 这些再各配一条常用命令，在这里逐条启停。
              </p>
            )}
            {rows.length > 0 && (
              <section className="cmd-pop__group" aria-label="常用命令">
                {rows.map((row) => {
                  const state = rowState(row);
                  const key = `${row.projectId}:${row.commandId}`;
                  const running = row.session && sessionRunning(row.session) ? row.session : null;
                  return (
                    <div className="cmd-pop__row" key={key}>
                      <span className={`cmd-pop__row-dot is-${state.tone}`} aria-hidden="true" />
                      <div className="cmd-pop__row-main">
                        <b>{row.name}</b>
                        <code>{commandSummary(row.command)}</code>
                      </div>
                      {state.text && <span className={`cmd-pop__row-state is-${state.tone}`}>{state.text}</span>}
                      <div className="cmd-pop__row-actions">
                        {busy === key ? <CircleNotch size={13} className="is-spinning" aria-label="执行中" /> : running ? (
                          <>
                            <button type="button" onClick={() => { setOpen(false); onOpenCommandLog(running); }} aria-label={`查看 ${row.name} 日志`}><Scroll size={13} />日志</button>
                            <button type="button" onClick={() => requestRun(row, "restart", row.command)} aria-label={`重启 ${row.name}`}><ArrowsClockwise size={13} />重启</button>
                            <button type="button" className="is-danger" onClick={() => act(row, "stop")} aria-label={`停止 ${row.name}`}><Square size={12} weight="fill" />停止</button>
                          </>
                        ) : (
                          <>
                            {row.session && <button type="button" onClick={() => { setOpen(false); onOpenCommandLog(row.session!); }} aria-label={`查看 ${row.name} 退出日志`}><Scroll size={13} />日志</button>}
                            <button type="button" className="is-primary" onClick={() => requestRun(row, "start", row.command)} aria-label={`执行 ${row.name}`}><Play size={12} weight="fill" />执行</button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </section>
            )}
          </div>
          {currentProject && currentProject.myRole === "admin" && (
            <div className="cmd-pop__foot">
              <button type="button" className="cmd-pop__manage" onClick={() => { setOpen(false); onManageCommands(); }}>
                管理常用命令…
              </button>
              <kbd aria-label={`快捷键 ${COMMANDS_SHORTCUT_LABEL}`}>{COMMANDS_SHORTCUT_LABEL}</kbd>
            </div>
          )}
        </div>
      )}

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
    </span>
  );
}
