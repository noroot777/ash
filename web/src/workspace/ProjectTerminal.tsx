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

function maximumHeight(): number {
  return Math.max(MIN_HEIGHT, Math.min(560, window.innerHeight - 210));
}

function clampHeight(value: number): number {
  return Math.max(MIN_HEIGHT, Math.min(maximumHeight(), Math.round(value)));
}

function initialHeight(): number {
  const stored = Number(readRenamedStorage(TERMINAL_HEIGHT_KEY));
  return Number.isFinite(stored) ? clampHeight(stored) : DEFAULT_HEIGHT;
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
  onMeta: (id: string, patch: Partial<Pick<ProjectTerminalTab, "cwd" | "status">>) => void;
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

  // attach tab 的正文说明:按当前会话事实追加一行灰字。触发点有二 —— 状态转变
  // (集中轮询推进 detached/ended)和 SSE replay 到 exit(重连后补写,否则 reset 把
  // 上一条连接写的说明冲掉了)。
  const announce = useCallback(() => {
    const terminal = terminalRef.current;
    const current = tabRef.current;
    if (!terminal || !current.attachSessionId) return;
    const flags = announcedRef.current;
    if (current.status === "detached" && !flags.detached) {
      flags.detached = true;
      terminal.write(`\r\n\x1b[90m启动脚本已退出（${current.exitCode ?? 0}），服务仍在运行 —— 停止/重启在状态栏\x1b[0m\r\n`);
    } else if (current.status === "ended" && !flags.ended) {
      flags.ended = true;
      terminal.write(current.stoppedByUser
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
      theme: {
        background: "#fbfbfc",
        foreground: "#2b2b30",
        cursor: "#5e6ad2",
        cursorAccent: "#fbfbfc",
        selectionBackground: "#dfe2fa",
        black: "#343438",
        red: "#c64a55",
        green: "#168466",
        yellow: "#a46f00",
        blue: "#5260c9",
        magenta: "#8250b6",
        cyan: "#0e879d",
        white: "#e8e8eb",
        brightBlack: "#76767d",
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
            void api.closeTerminalSession(project.id, session.id).catch(() => undefined);
            return;
          }
          sessionIdRef.current = session.id;
          onMeta(tab.id, { cwd: session.cwd });
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
      // attach 的会话不归这个 tab 管:关抽屉/收起 tab 只是不看了,服务照跑(停止走状态栏)。
      if (sessionIdRef.current && !tab.attachSessionId) {
        void api.closeTerminalSession(project.id, sessionIdRef.current).catch(() => undefined);
      }
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
  const firstTabId = useRef(clientTabId()).current;
  const nextOrdinal = useRef(2);
  const [height, setHeight] = useState(initialHeight);
  // tabs 和 activeId 是同一份状态:容量决策、victim 顶替和激活必须在同一个函数式
  // updater 里原子完成。拆成两个 state 时,「先读快照定分支、再对可能已变的 cur 插入」
  // 会在首次挂载与 focusRequest 并发时插出第 9 个 tab(第 3 轮审查实锤:抽屉关着
  // 直接从状态栏点日志,自动挂载和聚焦两个请求一起完成,React 批处理后超限)。
  const [pane, setPane] = useState<{ tabs: ProjectTerminalTab[]; activeId: string }>(() => ({
    tabs: [createTerminalTab(firstTabId, 1, project.name, project.repoPath)],
    activeId: firstTabId,
  }));
  const { tabs, activeId } = pane;
  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null;
  // focusRequest 拒绝提示的预判快照 —— 那个 effect 是一次性命令,不能依赖 tabs/activeId
  // (依赖自己会改的状态就会在用户切 tab/收起时重跑、把焦点抢回去);超限保证不靠它
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const consumedFocusSeq = useRef<number | null>(null);

  // 打开抽屉时把常驻命令会话(含刚退出还没回收的)挂成 attach tab,排在交互 shell 前面。
  // 同一条命令可能留着多条历史会话(重启一次多一条),tab 只挂最新那条 —— 全挂会出现
  // 一排重名 tab。自动挂载受 MAX_TABS 约束,挂不下的从状态栏「日志」点开。不自动激活:
  // 用户开抽屉多半是要敲命令,聚焦命令日志走 focusRequest。
  useEffect(() => {
    let alive = true;
    api.listTerminalSessions(project.id).then(({ sessions }) => {
      if (!alive) return;
      const newestPerCommand = new Map<string, (typeof sessions)[number]>();
      for (const session of sessions) {
        if (session.commandId === null) continue;
        const known = newestPerCommand.get(session.commandId);
        if (!known || session.startedAt > known.startedAt) newestPerCommand.set(session.commandId, session);
      }
      setPane((prev) => {
        const knownIds = new Set(prev.tabs.map((tab) => tab.attachSessionId).filter(Boolean));
        const added = [...newestPerCommand.values()]
          .filter((session) => !knownIds.has(session.id))
          .slice(0, Math.max(0, MAX_TABS - prev.tabs.length))
          .map((session) => createAttachTab(session));
        return added.length ? { ...prev, tabs: [...added, ...prev.tabs] } : prev;
      });
    }).catch(() => undefined); // 列表拿不到就只有普通 shell,不值得打断人
    return () => { alive = false; };
  }, [project.id]);

  // focusRequest 是**一次性命令**:同一个 seq 只消费一次(fetch 前就标记,任何 deps
  // 变化引起的重跑都被开头拦住),且**无论成功、失败、还是消费中被卸载,结局都是回执
  // 终结** —— 失败只吞不清会让旧请求潜伏在父层,靠卸载重置本地 ref 在下一次「打开
  // 终端」时突然重放(第 5 轮审查实锤);失败提示只给仍有效的请求(第 6 轮:被新请求
  // 顶掉的旧请求迟到失败,不该对着新请求的成功现场喊失败)。deps
  // 里绝不能有 activeId —— 依赖自己会修改的状态,用户切 tab/收起目标日志都会让
  // effect 重跑、把焦点抢回目标,抽屉从此被最后一次日志请求锁死(第 4 轮审查实锤)。
  useEffect(() => {
    if (!focusRequest || consumedFocusSeq.current === focusRequest.seq) return;
    consumedFocusSeq.current = focusRequest.seq;
    const { sessionId, seq } = focusRequest;
    const tabId = `attach:${sessionId}`;
    let alive = true;
    // tab 可能还不存在(刚从状态栏启动的会话),先查一次列表补上再激活。
    api.listTerminalSessions(project.id).then(({ sessions }) => {
      const session = sessions.find((item) => item.id === sessionId);
      if (alive && session) {
        // 「日志」入口和「新建 CLI」对 MAX_TABS 必须一致(第 2 轮审查),且判断-顶替-激活
        // 全部在同一个 updater 里对同一份 tabs 完成(第 3 轮审查:快照分支 + 延后插入会
        // 在首挂并发时超限)。满员时顶掉一个可让位的:非激活的 attach tab(收起无副作用,
        // 会话照跑),先挑已退出的;全让不出位(都是交互 shell/激活中)才拒绝 —— 拒绝时
        // tabs 和 activeId 都不动,active 不能指向没插入的 tab。
        const pickVictim = (list: ProjectTerminalTab[], active: string) => {
          const yieldable = (tab: ProjectTerminalTab) => tab.attachSessionId && tab.id !== active;
          return [...list].reverse().find((tab) => yieldable(tab) && tab.status === "ended")
            ?? [...list].reverse().find(yieldable);
        };
        setPane((prev) => {
          if (prev.tabs.some((tab) => tab.id === tabId)) return { ...prev, activeId: tabId };
          if (prev.tabs.length < MAX_TABS) {
            return { tabs: [createAttachTab(session), ...prev.tabs], activeId: tabId };
          }
          const victim = pickVictim(prev.tabs, prev.activeId);
          if (!victim) return prev;
          return { tabs: [createAttachTab(session), ...prev.tabs.filter((tab) => tab.id !== victim.id)], activeId: tabId };
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
      // 回执无条件(终结旧请求防重放),提示只给仍有效的请求 —— 已被新请求顶掉/已卸载的
      // 旧请求迟到失败时,页面事实是新请求的结果,再弹「失败请重点」就与同屏成功矛盾。
      if (alive) notify("打开命令日志失败，请再点一次");
      onFocusHandled?.(seq);
    });
    return () => { alive = false; };
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

  const updateTabMeta = useCallback((id: string, patch: Partial<Pick<ProjectTerminalTab, "cwd" | "status">>) => {
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

  const closeTab = (id: string) => {
    const next = withoutTerminalTab(tabs, activeId, id);
    if (!next.activeId) {
      onClose();
      return;
    }
    setPane({ tabs: next.tabs, activeId: next.activeId });
  };

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
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
    <section className="project-terminal" style={{ height }} aria-label={`${project.name} CLI`}>
      <div
        className="project-terminal__resize"
        role="separator"
        aria-label="调整 CLI 高度，双击恢复默认高度"
        aria-orientation="horizontal"
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={maximumHeight()}
        aria-valuenow={height}
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
                aria-label={tab.attachSessionId ? `收起 ${tab.label}（服务继续跑）` : `关闭 ${tab.label}`}
                onClick={() => closeTab(tab.id)}
              ><X size={12} /></button>
            </div>
          ))}
          <button type="button" className="project-terminal__add" aria-label="新建 CLI" onClick={addTab}>
            <Plus size={15} />
          </button>
        </div>
        <code>{activeTab?.cwd ?? project.repoPath}</code>
        <button type="button" className="project-terminal__drawer-close" aria-label="关闭全部 CLI" onClick={onClose}>
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
