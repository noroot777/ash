import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectView } from "@ash/shared";
import { api, type TerminalSessionInfo } from "../lib/api.ts";
import { createClientId } from "../lib/clientId.ts";
import {
  attachStatusOf,
  createAttachTab,
  createTerminalTab,
  type ProjectTerminalTab,
  withoutTerminalTab,
} from "./terminalTabs.ts";

// 底部坞的**会话账本**:开着哪几个终端、哪个在前台、抽屉展开没有。住在 WorkspaceShell 这一层
// 而不是抽屉组件里,因为「开着的终端」这排 tab 摆在状态栏上(workspace/StatusBar.tsx)——
// 抽屉收起时它照样要能说出「还有两个 shell 活着」,而抽屉组件那时候已经卸载了。
//
// 抽屉(ProjectTerminal)从此只负责 xterm 现场和高度:tabs / activeId / open 全部从这里下发。
//
// 会话是**持久**的(VSCode 语义):收起抽屉、收起 tab 都不杀 shell,真正结束它的只有 tab 上
// 的 ✕(shell)和 shell 自己 exit。所以这里分两档引导 —— 抽屉开着时是「接管现场」(恢复活
// shell、回收死透的会话槽、一个 shell 都没有就新建一个),抽屉关着时只是「看一眼」(照样把
// 已有会话列成 tab 给状态栏显示,但绝不新建、绝不回收 —— 一个从没点开过终端的人,不该因为
// 状态栏想显示点什么就被起一个 shell)。

export const MAX_TERMINAL_TABS = 8;
/** 抽屉开着 = 用户正盯着状态点,5s;收起后只是状态栏上一排小点,15s 够了。 */
const POLL_OPEN_MS = 5_000;
const POLL_PEEK_MS = 15_000;

// pane 自带「这是哪个项目的现场」:切项目时清空是 passive effect,而渲染紧跟 projectId 变化
// 那一帧就已经发生了。不带这个标记的话,那一帧会把 A 的 tab 交给 B 的抽屉,B 看见一个
// 「没有 attachSessionId 的 shell tab」就当成要新建,平白在 B 上起一个 shell(第 1 轮逻辑
// 审查实锤:切到 B 出现两次 create)。所以隔离做在**读的那一侧**,不等 effect。
type Pane = { projectId: string | null; tabs: ProjectTerminalTab[]; activeId: string };

const emptyPane = (projectId: string | null): Pane => ({ projectId, tabs: [], activeId: "" });
/** updater 里拿到的 prev 可能还是上一个项目的:先归一到目标项目再算。 */
const paneOf = (prev: Pane, projectId: string | null): Pane =>
  prev.projectId === projectId ? prev : emptyPane(projectId);
type TabMeta = Partial<Pick<ProjectTerminalTab, "cwd" | "status" | "sessionId">>;

export type TerminalDock = {
  open: boolean;
  tabs: ProjectTerminalTab[];
  activeId: string;
  activeTab: ProjectTerminalTab | null;
  /** 状态栏「终端」按钮和 G Z 的同一条路。 */
  toggle: () => void;
  reveal: () => void;
  hide: () => void;
  /** 点状态栏上的 tab:切到它并把抽屉展开。 */
  select: (id: string) => void;
  add: () => void;
  /** shell 的 ✕ = 结束会话;命令日志的 ✕ = 收起,服务照跑。 */
  close: (id: string) => void;
  /** 常用命令启动/看日志:把这条会话挂成 tab、展开抽屉并聚焦。 */
  openSession: (session: TerminalSessionInfo) => void;
  setMeta: (id: string, patch: TabMeta) => void;
};

/**
 * 满员时顶掉一个可让位的:非激活的**命令日志** tab(收起无副作用,会话照跑,下次还能从
 * 常用命令弹层点回来),先挑已退出的;交互 shell 不做 victim —— 收起它不杀会话,但 tab 无声
 * 消失、抽屉不重开就回不来,比拒绝更迷惑。
 */
function pickVictim(list: ProjectTerminalTab[], activeId: string): ProjectTerminalTab | undefined {
  const yieldable = (tab: ProjectTerminalTab) => tab.kind === "command" && tab.id !== activeId;
  return [...list].reverse().find((tab) => yieldable(tab) && tab.status === "ended")
    ?? [...list].reverse().find(yieldable);
}

export function useTerminalDock({
  project,
  enabled,
  notify,
}: {
  project: ProjectView | null;
  /** 多人模式下终端是实例管理员专属:没权限就整条坞都不存在。 */
  enabled: boolean;
  notify: (message: string) => void;
}): TerminalDock {
  const [open, setOpen] = useState(false);
  // tabs 和 activeId 是同一份状态:容量决策、victim 顶替和激活必须在同一个函数式 updater 里
  // 原子完成。拆成两个 state 时,「先读快照定分支、再对可能已变的 cur 插入」会在引导与聚焦
  // 并发时插出第 9 个 tab(第 3 轮审查实锤)。
  const [pane, setPane] = useState<Pane>(emptyPane(null));
  const projectId = project?.id ?? null;
  // 当前项目的现场;pane 还停在上一个项目时这里就是空的(见 Pane 上面那段)。
  const view = paneOf(pane, projectId);
  const { tabs, activeId } = view;
  const paneRef = useRef(view);
  paneRef.current = view;
  // 「此刻在哪个项目」。异步回调里不能读闭包里的 projectId —— 那一份和调用它的那次点击一样旧。
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const nextOrdinal = useRef(1);
  // 用户亲手收起过的会话:引导时跳过它们。命令日志的 ✕ 是「收起,服务照跑」——收完下一次
  // 引导又把它挂回来,那个 ✕ 就等于没按。要再看,从常用命令弹层点「日志」(openSession)。
  const dismissed = useRef(new Set<string>());

  // 换项目 = 换一整套会话:把上一套真正丢掉(读的那一侧已经隔离了,这里是把内存也收回),
  // 再由下面的引导按新项目的事实重建。
  useEffect(() => {
    nextOrdinal.current = 1;
    dismissed.current = new Set();
    setPane((prev) => prev.projectId === projectId ? prev : emptyPane(projectId));
  }, [projectId]);

  // 引导:按 server 会话事实建 tab。
  //   交互 shell:活着的全部恢复(attach,SSE 从 seq 0 重放,内容原样回来)。
  //   常用命令:同命令只挂最新一条(含刚退出还没回收的,日志可回看),排在 shell 前面。
  // 容量受 MAX_TERMINAL_TABS 约束,shell(交互现场)优先、命令日志填剩余,挂不下的从常用命令
  // 弹层点「日志」再进来。激活落在第一个 shell 上 —— 开抽屉多半是要敲命令。
  // open 变 true 时重跑一遍:顺手把别处新起的会话接进来,并清掉幽灵 tab。
  const projectName = project?.name ?? "";
  const projectRoot = project?.repoPath ?? "";
  useEffect(() => {
    // deps 只认 id / 名字 / 路径这三样事实,不认 project 对象引用 —— 列表刷新换一个新对象
    // 并不意味着终端现场要重新引导。
    if (!enabled || !projectId) return;
    const [id, name, repoPath] = [projectId, projectName, projectRoot];
    let alive = true;
    const freshTabId = createClientId();
    const seedFresh = () => {
      nextOrdinal.current = 2;
      setPane((prev) => {
        const mine = paneOf(prev, id);
        return mine.tabs.length ? mine : {
          projectId: id,
          tabs: [createTerminalTab(freshTabId, 1, name, repoPath)],
          activeId: freshTabId,
        };
      });
    };
    api.listTerminalSessions(id).then(({ sessions }) => {
      if (!alive) return;
      const newestPerCommand = new Map<string, TerminalSessionInfo>();
      for (const session of sessions) {
        if (session.commandId === null) continue;
        const known = newestPerCommand.get(session.commandId);
        if (!known || session.startedAt > known.startedAt) newestPerCommand.set(session.commandId, session);
      }
      const shellSessions = sessions
        .filter((session) => session.commandId === null && (session.exitCode === null || session.groupAlive))
        .filter((session) => !dismissed.current.has(session.id))
        .sort((a, b) => a.startedAt - b.startedAt);
      // 死透的交互 shell 占着会话槽,接管现场时顺手还回去 —— 只在抽屉开着时做。
      if (open) {
        for (const session of sessions) {
          if (session.commandId === null && session.exitCode !== null && !session.groupAlive) {
            void api.closeTerminalSession(id, session.id).catch(() => undefined);
          }
        }
      }
      nextOrdinal.current = (shellSessions.length || (open ? 1 : 0)) + 1;
      setPane((previous) => {
        const prev = paneOf(previous, id);
        // 先收幽灵:会话在 server 已不存在的命令日志 tab(重启后被同命令新会话顶替清掉)。
        // server 缓冲没了、内容只剩 xterm 里那份残影,留着只会在每次「启动→看日志」后攒一排
        // 「已退出」的重名 tab。只收 kind=command:交互 shell 的死活由自己的 ✕ 管。
        const liveIds = new Set(sessions.map((session) => session.id));
        const base = prev.tabs.filter((tab) => tab.kind !== "command" || !tab.attachSessionId || liveIds.has(tab.attachSessionId));
        // 已经在手上的会话:attach 来的看 attachSessionId,自己新建的 shell 看回填的 sessionId
        // —— 漏掉后者,再引导一次就会把刚建的那个 shell 当成「别处新起的」再挂一份。
        const known = new Set<string>();
        for (const tab of base) {
          if (tab.attachSessionId) known.add(tab.attachSessionId);
          if (tab.sessionId) known.add(tab.sessionId);
        }
        const shellTabs = shellSessions
          .map((session, index) => createAttachTab(session, {
            ordinal: index + 1,
            label: index === 0 ? name : `${name} ${index + 1}`,
          }))
          .filter((tab) => !(tab.attachSessionId && known.has(tab.attachSessionId)));
        const hasShell = shellTabs.length > 0 || base.some((tab) => tab.kind === "shell");
        // 「一个活 shell 都没有就新建一个」只发生在抽屉开着的时候。
        const fresh = hasShell || !open ? [] : [createTerminalTab(freshTabId, 1, name, repoPath)];
        const commandTabs = [...newestPerCommand.values()]
          .filter((session) => !known.has(session.id) && !dismissed.current.has(session.id))
          .map((session) => createAttachTab(session));
        const room = Math.max(0, MAX_TERMINAL_TABS - base.length);
        const keptShells = [...shellTabs, ...fresh].slice(0, room);
        const keptCommands = commandTabs.slice(0, Math.max(0, room - keptShells.length));
        const nextTabs = [...keptCommands, ...base, ...keptShells];
        if (nextTabs.length === 0) return prev.tabs.length ? emptyPane(id) : prev;
        const activeStays = prev.activeId && nextTabs.some((tab) => tab.id === prev.activeId);
        return {
          projectId: id,
          tabs: nextTabs,
          activeId: activeStays ? prev.activeId : (nextTabs.find((tab) => tab.kind === "shell") ?? nextTabs[0]).id,
        };
      });
    }).catch(() => { if (open && alive) seedFresh(); }); // 列表拿不到就退回「一个新 shell」,别让抽屉空着
    return () => { alive = false; };
  }, [enabled, open, projectId, projectName, projectRoot]);

  // 所有 attach tab 的状态点由这**一条**集中轮询驱动(会话事实:跑着/脚本退了服务在/死透),
  // 代替曾经的每 tab 各一个探测循环。门闩/超时/终态语义沿用单 tab 时代(第 8/9 轮审查打磨):
  // in-flight 未归不发下一轮(乱序防护)、每轮 4s 超时 abort(半开连接防护)、ended 终态不
  // 回退(旧响应防护)。全部 tab 到终态即停。
  const pollKey = tabs
    .filter((tab) => tab.attachSessionId && tab.status !== "ended")
    .map((tab) => tab.id).sort().join(",");
  useEffect(() => {
    if (!pollKey || !projectId) return;
    let alive = true;
    let probing = false;
    let inFlight: AbortController | null = null;
    const probe = () => {
      if (!alive || probing) return;
      probing = true;
      const controller = new AbortController();
      inFlight = controller;
      const timeout = window.setTimeout(() => controller.abort(), 4000);
      api.listTerminalSessions(projectId, controller.signal).then(({ sessions }) => {
        if (!alive) return;
        setPane((previous) => { const prev = paneOf(previous, projectId); return { ...prev, tabs: prev.tabs.map((tab) => {
          if (!tab.attachSessionId || tab.status === "ended") return tab; // ended 是终态
          const info = sessions.find((item) => item.id === tab.attachSessionId);
          // 会话在服务端已不存在 = 被同命令新会话顶替或闲置回收,对这个 tab 就是结束
          const status = info ? attachStatusOf(info) : "ended";
          const exitCode = info ? info.exitCode : tab.exitCode;
          const stoppedByUser = info?.stoppedByUser ?? tab.stoppedByUser;
          if (status === tab.status && exitCode === tab.exitCode && stoppedByUser === tab.stoppedByUser) return tab;
          return { ...tab, status, exitCode, stoppedByUser };
        }) }; });
      }).catch(() => undefined) // 拿不到事实就不动,下一轮再试
        .finally(() => {
          window.clearTimeout(timeout);
          if (inFlight === controller) inFlight = null;
          probing = false;
        });
    };
    const timer = window.setInterval(probe, open ? POLL_OPEN_MS : POLL_PEEK_MS);
    probe();
    return () => {
      alive = false;
      window.clearInterval(timer);
      inFlight?.abort();
    };
  }, [pollKey, projectId, open]);

  // 下面这些动作都作用在**当前项目**的现场上:updater 先经 paneOf 归一,pane 还停在上一个
  // 项目时它们不会误改别人的 tab。
  const setMeta = useCallback((id: string, patch: TabMeta) => {
    setPane((previous) => {
      const prev = paneOf(previous, projectId);
      return { ...prev, tabs: prev.tabs.map((tab) => tab.id === id ? { ...tab, ...patch } : tab) };
    });
  }, [projectId]);

  const select = useCallback((id: string) => {
    setPane((previous) => {
      const prev = paneOf(previous, projectId);
      return prev.tabs.some((tab) => tab.id === id) ? { ...prev, activeId: id } : prev;
    });
    setOpen(true);
  }, [projectId]);

  const add = useCallback(() => {
    if (!project) return;
    if (paneRef.current.tabs.length >= MAX_TERMINAL_TABS) {
      notify(`一个抽屉最多打开 ${MAX_TERMINAL_TABS} 个 CLI`);
      return;
    }
    const ordinal = nextOrdinal.current++;
    const tab = createTerminalTab(createClientId(), ordinal, project.name, project.repoPath);
    // 原子兜底:即使渲染值过期,updater 里也绝不越过上限
    setPane((previous) => {
      const prev = paneOf(previous, project.id);
      return prev.tabs.length >= MAX_TERMINAL_TABS ? prev : { ...prev, tabs: [...prev.tabs, tab], activeId: tab.id };
    });
    setOpen(true);
  }, [notify, project]);

  const close = useCallback((id: string) => {
    const snapshot = paneRef.current;
    const closing = snapshot.tabs.find((tab) => tab.id === id);
    if (closing?.attachSessionId) dismissed.current.add(closing.attachSessionId);
    const drop = () => {
      const now = paneRef.current;
      const next = withoutTerminalTab(now.tabs, now.activeId, id);
      setPane({ projectId: now.projectId, tabs: next.tabs, activeId: next.activeId ?? "" });
      if (!next.activeId) setOpen(false);
    };
    // 交互 shell 的 ✕ = 结束会话(VSCode 的垃圾桶,持久终端只有这里会杀它);命令日志的
    // ✕ = 收起,服务照跑(停止走常用命令弹层)。
    const sessionId = closing?.kind === "shell" ? closing.sessionId ?? closing.attachSessionId : undefined;
    if (!sessionId || !projectId) {
      drop();
      return;
    }
    // 「结束会话」要等 server 确认**整组进程**都清了才收 tab:单发一次信号就收,忽略 HUP/TERM
    // 的后台作业会成 PID 1 孤儿、把手还没了(第 1 轮自由审查实锤)。失败保留 tab + 提示,用户
    // 可重试;drop 用 paneRef 取新鲜状态,等待期间切 tab 不受影响。
    api.closeTerminalSession(projectId, sessionId)
      .then(drop)
      .catch((error) => notify(error instanceof Error ? error.message : "结束会话失败，请重试"));
  }, [notify, projectId]);

  const openSession = useCallback((session: TerminalSessionInfo) => {
    // 别家的会话进不来。常用命令点「执行」→ 请求还没回来人已经切走,那条 .then 捕获的仍是切走
    // 前的这只回调,照样会调进来(第 2 轮逻辑审查实锤)。放行的话:setOpen(true) 展开的是
    // **当前**项目的抽屉,而 tab 写进的是原项目的 pane —— 当前项目看见「抽屉开着却一个 shell
    // 都没有」,引导 effect 就在这个用户根本没碰过终端的项目上凭空起一个 shell。
    // 比的是 ref 而不是闭包里的 projectId:闭包和它的调用方一样旧,两边一样旧就比不出来。
    if (session.projectId !== projectIdRef.current) {
      notify(`${session.name} 的日志在原来的项目里，切回去就能看`);
      return;
    }
    const tabId = `attach:${session.id}`;
    dismissed.current.delete(session.id); // 显式要看的,收起过也得回来
    setOpen(true);
    setPane((previous) => {
      const prev = paneOf(previous, session.projectId);
      if (prev.tabs.some((tab) => tab.id === tabId)) return { ...prev, activeId: tabId };
      if (prev.tabs.length < MAX_TERMINAL_TABS) return { ...prev, tabs: [createAttachTab(session), ...prev.tabs], activeId: tabId };
      const victim = pickVictim(prev.tabs, prev.activeId);
      // 全让不出位才拒绝 —— 拒绝时 tabs 和 activeId 都不动,active 不能指向没插入的 tab。
      if (!victim) return prev;
      return { ...prev, tabs: [createAttachTab(session), ...prev.tabs.filter((tab) => tab.id !== victim.id)], activeId: tabId };
    });
    // 提示走渲染快照的预判:拒绝只发生在「满员且全是 shell/激活」的稳定态,快照准确。
    const snapshot = paneRef.current;
    if (!snapshot.tabs.some((tab) => tab.id === tabId) && snapshot.tabs.length >= MAX_TERMINAL_TABS
      && !pickVictim(snapshot.tabs, snapshot.activeId)) {
      notify(`一个抽屉最多打开 ${MAX_TERMINAL_TABS} 个 CLI，先收起一个再看日志`);
    }
  }, [notify]);

  const toggle = useCallback(() => setOpen((value) => !value), []);
  const reveal = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);

  return {
    open: open && enabled && !!project,
    tabs: enabled ? tabs : [],
    activeId,
    activeTab: tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null,
    toggle,
    reveal,
    hide,
    select,
    add,
    close,
    openSession,
    setMeta,
  };
}
