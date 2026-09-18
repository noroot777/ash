import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectView } from "@ash/shared";
import { Plus, TerminalWindow, X } from "@phosphor-icons/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api, type TerminalEvent } from "../lib/api.ts";
import { createClientId } from "../lib/clientId.ts";
import { readRenamedStorage } from "../lib/renamedStorage.ts";
import {
  attachStatusOf,
  createAttachTab,
  createTerminalTab,
  type ProjectTerminalTab,
  type TerminalStatus,
  withoutTerminalTab,
} from "./terminalTabs.ts";

const TERMINAL_HEIGHT_KEY = "ash:terminal-height";
const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 170;
const MAX_TABS = 8;

function maximumHeight(viewportHeight: number = window.innerHeight): number {
  return Math.max(MIN_HEIGHT, Math.min(560, viewportHeight - 210));
}

function clampHeight(value: number, viewportHeight?: number): number {
  return Math.max(MIN_HEIGHT, Math.min(maximumHeight(viewportHeight), Math.round(value)));
}

function initialHeight(): number {
  // 没存过时 readRenamedStorage 给的是 null,Number(null) = 0 —— 0 也是有限数,照单全收
  // 就等于每个新用户第一次开终端都只得到 MIN_HEIGHT 那一条缝,而不是 DEFAULT_HEIGHT。
  const stored = Number(readRenamedStorage(TERMINAL_HEIGHT_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampHeight(stored) : DEFAULT_HEIGHT;
}

function clientTabId(): string {
  return createClientId();
}

function statusLabel(status: TerminalStatus): string {
  return status === "starting" ? "正在启动"
    : status === "ready" ? "已连接"
      : status === "reconnecting" ? "正在重连"
        : status === "detached" ? "服务运行中（启动脚本已退出）"
          : status === "ended" ? "已退出"
            : "连接失败";
}

function TerminalPane({
  active,
  project,
  tab,
  notify,
  onMeta,
}: {
  active: boolean;
  project: ProjectView;
  tab: ProjectTerminalTab;
  notify: (message: string) => void;
  onMeta: (id: string, patch: Partial<Pick<ProjectTerminalTab, "cwd" | "status" | "sessionId">>) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(tab.attachSessionId ?? null);
  // shell tab 的会话要 create 完才有 id;attach tab 一开始就有。流 effect 等这个。
  const [establishedId, setEstablishedId] = useState<string | null>(tab.attachSessionId ?? null);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  // 每条 SSE 连接生命周期内,每种说明只写一次(重连 reset 后重置,replay 末尾补写)。
  const announcedRef = useRef({ detached: false, ended: false });
  const prevStatusRef = useRef(tab.status);

  // attach tab 的正文说明:按当前会话事实追加一行灰字,措辞按 tab 身份分两套(命令日志
  // 说「服务」,恢复的交互 shell 说「进程」)。触发点有二 —— 状态转变(集中轮询推进
  // detached/ended)和 SSE replay 到 exit(重连后补写,否则 reset 把上一条连接写的说明
  // 冲掉了)。
  const announce = useCallback(() => {
    const terminal = terminalRef.current;
    const current = tabRef.current;
    if (!terminal || !current.attachSessionId) return;
    const flags = announcedRef.current;
    const isCommand = current.kind === "command";
    if (current.status === "detached" && !flags.detached) {
      flags.detached = true;
      terminal.write(isCommand
        ? `\r\n\x1b[90m启动脚本已退出（${current.exitCode ?? 0}），服务仍在运行 —— 停止/重启在状态栏\x1b[0m\r\n`
        : `\r\n\x1b[90mshell 已退出（${current.exitCode ?? 0}），它启动的后台进程仍在运行\x1b[0m\r\n`);
    } else if (current.status === "ended" && !flags.ended) {
      flags.ended = true;
      terminal.write(!isCommand
        ? `\r\n\x1b[90m进程已退出（${current.exitCode ?? 0}）\x1b[0m\r\n`
        : current.stoppedByUser
          ? "\r\n\x1b[90m服务已停止\x1b[0m\r\n"
          : flags.detached
            ? "\r\n\x1b[90m服务已退出\x1b[0m\r\n"
            : `\r\n\x1b[90m进程已退出（${current.exitCode ?? 0}）\x1b[0m\r\n`);
    }
  }, []);

  useEffect(() => {
    if (prevStatusRef.current === tab.status) return;
    prevStatusRef.current = tab.status;
    announce();
  }, [tab.status, announce]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try { fitRef.current?.fit(); terminalRef.current?.focus(); } catch { /* pane was removed */ }
    });
  }, [active]);

  // 基座:xterm 实例、输入/резize 通道、shell 会话的创建与关闭。日志流不在这里 ——
  // 它跟随 active(见下一个 effect),隐藏 tab 不占长连接。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
    let inputBuffer = "";
    let inputTimer: number | null = null;
    let inputChain = Promise.resolve();
    let resizeTimer: number | null = null;
    let pendingSize: { cols: number; rows: number } | null = null;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.35,
      scrollback: 5000,
      allowTransparency: true,
      // 底部坞是深色的(terminal.css),xterm 的调色板跟着走:浅色那套落在 #17181d 上
      // 只剩一团糊。色值取自设计稿 demo(docs/demos/project-command-center/shared.css)。
      theme: {
        background: "#17181d",
        foreground: "#c9cbd6",
        cursor: "#8f9aff",
        cursorAccent: "#17181d",
        selectionBackground: "#3a3d55",
        black: "#2b2c34",
        red: "#ef7a86",
        green: "#58c99a",
        yellow: "#e0b356",
        blue: "#7f9cf5",
        magenta: "#c08bf0",
        cyan: "#5ac8d8",
        white: "#c9cbd6",
        brightBlack: "#71737f",
        brightWhite: "#ecedf2",
      },
    });
    const fit = new FitAddon();
    terminalRef.current = terminal;
    fitRef.current = fit;
    terminal.loadAddon(fit);
    terminal.open(host);

    const showConnectionError = (reason: unknown) => {
      if (!alive) return;
      onMeta(tab.id, { status: "error" });
      const message = reason instanceof Error ? reason.message : String(reason);
      terminal.write(`\r\n\x1b[31mCLI 连接失败：${message}\x1b[0m\r\n`);
      notify(`CLI 连接失败：${message}`);
    };
    const flushInput = () => {
      inputTimer = null;
      const sessionId = sessionIdRef.current;
      if (!sessionId || !inputBuffer) return;
      const data = inputBuffer;
      inputBuffer = "";
      inputChain = inputChain
        .then(() => api.writeTerminalSession(project.id, sessionId, data))
        .catch(showConnectionError);
    };
    const queueInput = (data: string) => {
      inputBuffer += data;
      if (inputTimer === null) inputTimer = window.setTimeout(flushInput, 12);
    };
    const flushResize = () => {
      resizeTimer = null;
      const sessionId = sessionIdRef.current;
      if (!sessionId || !pendingSize) return;
      const size = pendingSize;
      pendingSize = null;
      void api.resizeTerminalSession(project.id, sessionId, size).catch(showConnectionError);
    };
    const queueResize = (cols: number, rows: number) => {
      pendingSize = { cols, rows };
      if (resizeTimer === null) resizeTimer = window.setTimeout(flushResize, 80);
    };

    const input = terminal.onData(queueInput);
    const resize = terminal.onResize(({ cols, rows }) => queueResize(cols, rows));
    const observer = new ResizeObserver(() => {
      if (host.offsetParent === null) return;
      try { fit.fit(); } catch { /* hidden during teardown */ }
    });
    observer.observe(host);
    requestAnimationFrame(() => {
      if (host.offsetParent === null) return;
      try { fit.fit(); terminal.focus(); } catch { /* component was removed */ }
    });

    if (!tab.attachSessionId) {
      void api.createTerminalSession(project.id, { cols: terminal.cols, rows: terminal.rows })
        .then((session) => {
          if (!alive) {
            // 会话建成前 tab 就没了(关抽屉/StrictMode 重挂):还没人看过一眼,直接收掉,
            // 不留一个空 shell 等下次恢复。
            void api.closeTerminalSession(project.id, session.id).catch(() => undefined);
            return;
          }
          sessionIdRef.current = session.id;
          // sessionId 回填到 tab 上:交互 shell 的 ✕(closeTab)靠它结束会话。
          onMeta(tab.id, { cwd: session.cwd, sessionId: session.id });
          setEstablishedId(session.id);
          flushInput();
          queueResize(terminal.cols, terminal.rows);
        })
        .catch(showConnectionError);
    }

    return () => {
      alive = false;
      observer.disconnect();
      input.dispose();
      resize.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      if (inputTimer !== null) window.clearTimeout(inputTimer);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      // 会话是持久的(VSCode 语义):unmount 只发生在关抽屉/收起 tab/切项目,这些都不杀
      // shell —— 重开抽屉从会话列表原样恢复。结束会话统一走 closeTab 的 DELETE。
    };
  }, [notify, onMeta, project.id, tab.id, tab.attachSessionId]);

  // 日志流:只有激活 tab 保持 SSE。每个隐藏 tab 一条常驻长连接会把 Chrome 的同源
  // 连接池(HTTP/1.1 同主机 6 条)占满,停止/重启和一切状态轮询全部 pending,控制面
  // 冻结(第 1 轮审查实锤:6 条活命令即可复现)。切走即断,切回 reset 后从 seq 0
  // 重放服务端缓冲 —— 日志不丢,连接数恒为 1。
  useEffect(() => {
    if (!active || !establishedId) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    let alive = true;
    let ended = false;
    terminal.reset();
    announcedRef.current = { detached: false, ended: false };
    const source = new EventSource(api.terminalEventsUrl(project.id, establishedId));
    // attach tab 的状态点表达会话/服务事实,由集中轮询驱动,连接事件不碰它。
    source.onopen = () => { if (alive && !ended && !tab.attachSessionId) onMeta(tab.id, { status: "ready" }); };
    source.onmessage = (message) => {
      if (!alive) return;
      const event = JSON.parse(message.data) as TerminalEvent;
      if (event.type === "data") {
        terminal.write(event.data);
        return;
      }
      ended = true;
      if (tab.attachSessionId) {
        // 组长退了 ≠ 命令死了(daemonize),结论归集中轮询;这里只按已知事实补写说明
        // (重放场景:上一条连接写过的说明被 reset 冲掉了,exit 是重放的收尾信号)。
        announce();
      } else {
        onMeta(tab.id, { status: "ended" });
        terminal.write(`\r\n\x1b[90m进程已退出（${event.exitCode}）\x1b[0m\r\n`);
      }
    };
    source.onerror = () => {
      if (!alive || ended || tab.attachSessionId) return;
      onMeta(tab.id, { status: "reconnecting" });
    };
    return () => {
      alive = false;
      source.close();
    };
  }, [active, establishedId, project.id, tab.id, tab.attachSessionId, onMeta, announce]);

  return (
    <div
      ref={hostRef}
      id={`terminal-panel-${tab.id}`}
      className="project-terminal__viewport"
      role="tabpanel"
      aria-labelledby={`terminal-tab-${tab.id}`}
      aria-label={`${tab.label} 终端内容`}
      hidden={!active}
    />
  );
}

export function ProjectTerminal({
  project,
  focusRequest,
  onFocusHandled,
  onClose,
  notify,
}: {
  project: ProjectView;
  /** 状态栏「日志」点过来:打开/切到这条命令会话的 tab。seq 保证同一会话点两次也生效。 */
  focusRequest?: { sessionId: string; seq: number } | null;
  /** 一次性命令消费完的回执(带 seq,父层只清对应请求),防止重挂后重放。 */
  onFocusHandled?: (seq: number) => void;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const nextOrdinal = useRef(1);
  const [height, setHeight] = useState(initialHeight);
  // 底部坞在窗口里横着占一整行,高度不跟着窗口收就会把上面的工作区整个挤没(实测:
  // 560 的终端 + 620 高的窗口 = 侧栏和主区只剩 34px)。**存的是用户挑的那个高度,
  // 用的是按当前窗口夹过的值** —— 窗口临时变矮不该顺手把他的偏好改小,拉回来还得再调一次。
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const appliedHeight = clampHeight(height, viewportHeight);
  // tabs 和 activeId 是同一份状态:容量决策、victim 顶替和激活必须在同一个函数式
  // updater 里原子完成。拆成两个 state 时,「先读快照定分支、再对可能已变的 cur 插入」
  // 会在首次挂载与 focusRequest 并发时插出第 9 个 tab(第 3 轮审查实锤:抽屉关着
  // 直接从状态栏点日志,自动挂载和聚焦两个请求一起完成,React 批处理后超限)。
  //
  // 初始为空:开哪些 tab 由下面的引导 effect 按 server 会话事实决定 —— 终端是持久的,
  // 上次留下的 shell 要原样回来,不能一挂载就无条件新建一个。
  const [pane, setPane] = useState<{ tabs: ProjectTerminalTab[]; activeId: string }>({ tabs: [], activeId: "" });
  const { tabs, activeId } = pane;
  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null;
  // focusRequest 拒绝提示的预判快照 —— 那个 effect 是一次性命令,不能依赖 tabs/activeId
  // (依赖自己会改的状态就会在用户切 tab/收起时重跑、把焦点抢回去);超限保证不靠它
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const consumedFocusSeq = useRef<number | null>(null);

  // 打开抽屉时的引导:按 server 会话事实恢复现场(VSCode 语义 —— 关抽屉只是收起)。
  //   交互 shell:活着的全部恢复(attach,SSE 从 seq 0 重放,内容原样回来);整组死透的
  //   顺手 DELETE,把会话槽还回去。一个活 shell 都没有才新建一个。
  //   常用命令:同命令只挂最新一条(含刚退出还没回收的,日志可回看),排在 shell 前面。
  // 容量受 MAX_TABS 约束,shell(交互现场)优先、命令日志填剩余,挂不下的从状态栏
  // 「日志」点开。激活落在第一个 shell 上 —— 开抽屉多半是要敲命令。
  useEffect(() => {
    let alive = true;
    const freshTabId = clientTabId();
    const seedFresh = () => {
      nextOrdinal.current = 2;
      setPane((prev) => prev.tabs.length ? prev : {
        tabs: [createTerminalTab(freshTabId, 1, project.name, project.repoPath)],
        activeId: freshTabId,
      });
    };
    api.listTerminalSessions(project.id).then(({ sessions }) => {
      if (!alive) return;
      const newestPerCommand = new Map<string, (typeof sessions)[number]>();
      for (const session of sessions) {
        if (session.commandId === null) continue;
        const known = newestPerCommand.get(session.commandId);
        if (!known || session.startedAt > known.startedAt) newestPerCommand.set(session.commandId, session);
      }
      const shellSessions = sessions
        .filter((session) => session.commandId === null && (session.exitCode === null || session.groupAlive))
        .sort((a, b) => a.startedAt - b.startedAt);
      for (const session of sessions) {
        if (session.commandId === null && session.exitCode !== null && !session.groupAlive) {
          void api.closeTerminalSession(project.id, session.id).catch(() => undefined);
        }
      }
      nextOrdinal.current = shellSessions.length === 0 ? 2 : shellSessions.length + 1;
      setPane((prev) => {
        const known = new Set(prev.tabs.map((tab) => tab.attachSessionId).filter(Boolean));
        const shellTabs = shellSessions
          .map((session, index) => createAttachTab(session, {
            ordinal: index + 1,
            label: index === 0 ? project.name : `${project.name} ${index + 1}`,
          }))
          .filter((tab) => !known.has(tab.attachSessionId));
        const commandTabs = [...newestPerCommand.values()]
          .filter((session) => !known.has(session.id))
          .map((session) => createAttachTab(session));
        const hasShell = shellTabs.length > 0 || prev.tabs.some((tab) => tab.kind === "shell");
        const fresh = hasShell ? [] : [createTerminalTab(freshTabId, 1, project.name, project.repoPath)];
        const room = Math.max(0, MAX_TABS - prev.tabs.length);
        const keptShells = [...shellTabs, ...fresh].slice(0, room);
        const keptCommands = commandTabs.slice(0, Math.max(0, room - keptShells.length));
        const nextTabs = [...keptCommands, ...prev.tabs, ...keptShells];
        if (nextTabs.length === 0) return prev;
        const activeStays = prev.activeId && nextTabs.some((tab) => tab.id === prev.activeId);
        return {
          tabs: nextTabs,
          activeId: activeStays ? prev.activeId : (nextTabs.find((tab) => tab.kind === "shell") ?? nextTabs[0]).id,
        };
      });
    }).catch(seedFresh); // 列表拿不到就退回「一个新 shell」,别让抽屉空着
    return () => { alive = false; };
  }, [project.id, project.name, project.repoPath]);

  // focusRequest 是**一次性命令**:同一个 seq 只消费一次(fetch 前就标记,任何 deps
  // 变化引起的重跑都被开头拦住),且**结局必是回执终结** —— 失败只吞不清会让旧请求
  // 潜伏在父层,靠卸载重置本地 ref 在下一次「打开终端」时突然重放(第 5 轮审查实锤);
  // 失败提示只给仍有效的请求(第 6 轮:被新请求顶掉的旧请求迟到失败,不该对着新请求
  // 的成功现场喊失败)。deps
  // 里绝不能有 activeId —— 依赖自己会修改的状态,用户切 tab/收起目标日志都会让
  // effect 重跑、把焦点抢回目标,抽屉从此被最后一次日志请求锁死(第 4 轮审查实锤)。
  useEffect(() => {
    if (!focusRequest || consumedFocusSeq.current === focusRequest.seq) return;
    consumedFocusSeq.current = focusRequest.seq;
    const { sessionId, seq } = focusRequest;
    const tabId = `attach:${sessionId}`;
    let alive = true;
    let settled = false;
    // 作废轮(cleanup 已跑)的迟到响应:seq 已被重挂的下一轮接手(StrictMode 双跑,
    // consumedFocusSeq 又等于本 seq)就什么都不做,回执归那一轮;真没人接手(抽屉
    // 整个卸载了)才补回执终结请求,防潜伏重放(第 5 轮语义在双跑下的拆分)。
    const settleOrphan = () => {
      if (consumedFocusSeq.current !== seq) onFocusHandled?.(seq);
    };
    // tab 可能还不存在(刚从状态栏启动的会话),先查一次列表补上再激活。
    api.listTerminalSessions(project.id).then(({ sessions }) => {
      settled = true;
      if (!alive) return settleOrphan();
      const session = sessions.find((item) => item.id === sessionId);
      if (session) {
        // 「日志」入口和「新建 CLI」对 MAX_TABS 必须一致(第 2 轮审查),且判断-顶替-激活
        // 全部在同一个 updater 里对同一份 tabs 完成(第 3 轮审查:快照分支 + 延后插入会
        // 在首挂并发时超限)。满员时顶掉一个可让位的:非激活的**命令日志** tab(收起无
        // 副作用,会话照跑,下次还能从状态栏点回来),先挑已退出的;交互 shell 不做 victim
        // —— 收起它不杀会话,但 tab 无声消失、抽屉不重开就回不来,比拒绝更迷惑。全让
        // 不出位才拒绝 —— 拒绝时 tabs 和 activeId 都不动,active 不能指向没插入的 tab。
        const pickVictim = (list: ProjectTerminalTab[], active: string) => {
          const yieldable = (tab: ProjectTerminalTab) => tab.kind === "command" && tab.id !== active;
          return [...list].reverse().find((tab) => yieldable(tab) && tab.status === "ended")
            ?? [...list].reverse().find(yieldable);
        };
        setPane((prev) => {
          // 先收幽灵:会话在 server 已不存在的命令日志 tab(重启后被同命令新会话顶替清掉)。
          // server 缓冲没了、内容只剩 xterm 里那份残影,留着只会在每次「启动→看日志」后
          // 攒一排「已退出」的重名 tab。只收 kind=command:交互 shell 的死活由自己的 ✕ 管。
          const liveIds = new Set(sessions.map((item) => item.id));
          const tabs = prev.tabs.filter((tab) => tab.kind !== "command" || !tab.attachSessionId || liveIds.has(tab.attachSessionId));
          if (tabs.some((tab) => tab.id === tabId)) return { tabs, activeId: tabId };
          if (tabs.length < MAX_TABS) {
            return { tabs: [createAttachTab(session), ...tabs], activeId: tabId };
          }
          const victim = pickVictim(tabs, prev.activeId);
          if (!victim) return prev;
          return { tabs: [createAttachTab(session), ...tabs.filter((tab) => tab.id !== victim.id)], activeId: tabId };
        });
        // 提示走渲染快照的预判:拒绝只发生在「满员且全是 shell/激活」的稳定态,快照准确;
        // 首挂并发的竞态态挂的全是可让位的 attach tab,不会走到拒绝。
        const snapshot = paneRef.current;
        if (!snapshot.tabs.some((tab) => tab.id === tabId) && snapshot.tabs.length >= MAX_TABS
          && !pickVictim(snapshot.tabs, snapshot.activeId)) {
          notify(`一个抽屉最多打开 ${MAX_TABS} 个 CLI，先收起一个再看日志`);
        }
      }
      // 会话已经没了(状态栏的日志按钮只出现在会话还在时,竞态兜底)也算命令终结
      onFocusHandled?.(seq);
    }).catch(() => {
      settled = true;
      if (!alive) return settleOrphan();
      // 提示只给仍有效的请求 —— 已被顶掉/已卸载的旧请求迟到失败时,页面事实是新请求
      // 的结果,再弹「失败请重点」就与同屏成功矛盾。
      notify("打开命令日志失败，请再点一次");
      onFocusHandled?.(seq);
    });
    return () => {
      alive = false;
      // StrictMode 开发态 effect→cleanup→effect 双跑:第一轮请求未归就被 cleanup,不归
      // 还 seq 的话,重挂的第二轮会被开头「已消费」拦住直接退出,聚焦静默丢失(第 1 轮
      // 自由审查实锤:预览态点启动后选中的是默认 shell 而不是服务日志)。只归还**未
      // settle** 的轮次 —— 已回执的轮次再归还 seq,deps 抖动重跑时会重复消费、把焦点
      // 从用户手里抢回来(第 4 轮语义)。
      if (!settled && consumedFocusSeq.current === seq) consumedFocusSeq.current = null;
    };
  }, [focusRequest, project.id, notify, onFocusHandled]);

  // 所有 attach tab 的状态点由这**一条**集中轮询驱动(会话事实:跑着/脚本退了服务在/
  // 死透),代替曾经的每 tab 各一个探测循环 —— N 个日志 tab 只发一路状态请求,长连接
  // 也只有激活 tab 一条(见 TerminalPane 的流 effect)。门闩/超时/终态语义沿用单 tab
  // 时代(第 8/9 轮审查打磨):in-flight 未归不发下一轮(乱序防护)、每轮 4s 超时
  // abort(半开连接防护)、ended 终态不回退(旧响应防护)。全部 tab 到终态即停。
  const pollKey = tabs
    .filter((tab) => tab.attachSessionId && tab.status !== "ended")
    .map((tab) => tab.id).sort().join(",");
  useEffect(() => {
    if (!pollKey) return;
    let alive = true;
    let probing = false;
    let inFlight: AbortController | null = null;
    const probe = () => {
      if (!alive || probing) return;
      probing = true;
      const controller = new AbortController();
      inFlight = controller;
      const timeout = window.setTimeout(() => controller.abort(), 4000);
      api.listTerminalSessions(project.id, controller.signal).then(({ sessions }) => {
        if (!alive) return;
        setPane((prev) => ({ ...prev, tabs: prev.tabs.map((tab) => {
          if (!tab.attachSessionId || tab.status === "ended") return tab; // ended 是终态
          const info = sessions.find((item) => item.id === tab.attachSessionId);
          // 会话在服务端已不存在 = 被同命令新会话顶替或闲置回收,对这个 tab 就是结束
          const status = info ? attachStatusOf(info) : "ended";
          const exitCode = info ? info.exitCode : tab.exitCode;
          const stoppedByUser = info?.stoppedByUser ?? tab.stoppedByUser;
          if (status === tab.status && exitCode === tab.exitCode && stoppedByUser === tab.stoppedByUser) return tab;
          return { ...tab, status, exitCode, stoppedByUser };
        }) }));
      }).catch(() => undefined) // 拿不到事实就不动,下一轮再试
        .finally(() => {
          window.clearTimeout(timeout);
          if (inFlight === controller) inFlight = null;
          probing = false;
        });
    };
    const timer = window.setInterval(probe, 5000);
    probe();
    return () => {
      alive = false;
      window.clearInterval(timer);
      inFlight?.abort();
    };
  }, [pollKey, project.id]);

  useEffect(() => {
    window.localStorage.setItem(TERMINAL_HEIGHT_KEY, String(height));
  }, [height]);

  const updateTabMeta = useCallback((id: string, patch: Partial<Pick<ProjectTerminalTab, "cwd" | "status" | "sessionId">>) => {
    setPane((prev) => ({ ...prev, tabs: prev.tabs.map((tab) => tab.id === id ? { ...tab, ...patch } : tab) }));
  }, []);

  const addTab = () => {
    if (tabs.length >= MAX_TABS) {
      notify(`一个抽屉最多打开 ${MAX_TABS} 个 CLI`);
      return;
    }
    const ordinal = nextOrdinal.current++;
    const tab = createTerminalTab(clientTabId(), ordinal, project.name, project.repoPath);
    // 原子兜底:即使渲染值过期,updater 里也绝不越过上限
    setPane((prev) => prev.tabs.length >= MAX_TABS ? prev : { tabs: [...prev.tabs, tab], activeId: tab.id });
  };

  const removeTab = (id: string) => {
    const snapshot = paneRef.current;
    const next = withoutTerminalTab(snapshot.tabs, snapshot.activeId, id);
    if (!next.activeId) {
      onClose();
      return;
    }
    setPane({ tabs: next.tabs, activeId: next.activeId });
  };

  const closeTab = (id: string) => {
    const closing = paneRef.current.tabs.find((tab) => tab.id === id);
    // 交互 shell 的 ✕ = 结束会话(VSCode 的垃圾桶,持久终端只有这里会杀它);命令日志的
    // ✕ = 收起,服务照跑(停止走状态栏)。
    const sessionId = closing?.kind === "shell" ? closing.sessionId ?? closing.attachSessionId : undefined;
    if (!sessionId) {
      removeTab(id);
      return;
    }
    // 「结束会话」要等 server 确认**整组进程**都清了才收 tab:单发一次信号就收,忽略
    // HUP/TERM 的后台作业会成 PID 1 孤儿、把手还没了(第 1 轮自由审查实锤)。失败保留
    // tab + 提示,用户可重试;removeTab 用 paneRef 取新鲜状态,等待期间切 tab 不受影响。
    api.closeTerminalSession(project.id, sessionId)
      .then(() => removeTab(id))
      .catch((error) => {
        notify(error instanceof Error ? error.message : "结束会话失败，请重试");
      });
  };

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = appliedHeight;
    document.body.classList.add("terminal-drawer-resizing");
    const move = (next: PointerEvent) => setHeight(clampHeight(startHeight + startY - next.clientY));
    const finish = () => {
      document.body.classList.remove("terminal-drawer-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  return (
    <section className="project-terminal" style={{ height: appliedHeight }} aria-label={`${project.name} CLI`}>
      <div
        className="project-terminal__resize"
        role="separator"
        aria-label="调整 CLI 高度，双击恢复默认高度"
        aria-orientation="horizontal"
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={maximumHeight(viewportHeight)}
        aria-valuenow={appliedHeight}
        onPointerDown={beginResize}
        onDoubleClick={() => setHeight(DEFAULT_HEIGHT)}
      />
      <header className="project-terminal__bar">
        <div className="project-terminal__tabs" role="tablist" aria-label="CLI 终端">
          {tabs.map((tab) => (
            <div className={`project-terminal__tab-shell${tab.id === activeId ? " is-active" : ""}`} key={tab.id}>
              <button
                type="button"
                className="project-terminal__tab"
                role="tab"
                id={`terminal-tab-${tab.id}`}
                aria-controls={`terminal-panel-${tab.id}`}
                aria-selected={tab.id === activeId}
                onClick={() => setPane((prev) => ({ ...prev, activeId: tab.id }))}
              >
                <TerminalWindow size={14} weight={tab.id === activeId ? "fill" : "regular"} />
                <b>{tab.label}</b>
                <span className={`project-terminal__status is-${tab.status}`} aria-label={statusLabel(tab.status)} />
              </button>
              <button
                type="button"
                className="project-terminal__tab-close"
                aria-label={tab.kind === "command" ? `收起 ${tab.label}（服务继续跑）` : `关闭 ${tab.label}（结束会话）`}
                onClick={() => closeTab(tab.id)}
              ><X size={12} /></button>
            </div>
          ))}
          <button type="button" className="project-terminal__add" aria-label="新建 CLI" onClick={addTab}>
            <Plus size={15} />
          </button>
        </div>
        <code>{activeTab?.cwd ?? project.repoPath}</code>
        <button type="button" className="project-terminal__drawer-close" aria-label="收起终端（shell 与服务继续跑）" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      {tabs.map((tab) => (
        <TerminalPane
          key={tab.id}
          tab={tab}
          project={project}
          active={tab.id === activeId}
          notify={notify}
          onMeta={updateTabMeta}
        />
      ))}
    </section>
  );
}
