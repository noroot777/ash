import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MagnifyingGlass, Paperclip } from "@phosphor-icons/react";
import type { ProjectView, TaskListItem } from "@ash/shared";
import type { UserMessage } from "@ash/shared/user-messages";
import { api } from "../lib/api.ts";
import { splitMessageQuotes } from "../lib/messageQuotes.ts";
import { indexWorkers, workersFrom } from "../lib/taskAttention.ts";
import { taskLook } from "../lib/taskLook.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { requestMessageReveal } from "../search/messageReveal.ts";
import { attachmentView } from "../task-detail/utils.ts";
import { sidebarRowOrder, type SidebarRowOrder } from "../workspace/sidebarNavigation.ts";
import { RowMark } from "../workspace/TaskTreeRows.tsx";
import { clockOf, highlightParts, messageMatches, openDecision, recallBlocks, recallMembers, recallOrder, recallTaskRows, type RecallTaskRow } from "./recallModel.ts";
import { useRecallHits, useRecallMessagesOf } from "./useRecallData.ts";
import "../styles/recall.css";

/**
 * R 键：以任务为主找我说过的话。左边是任务，顺序、范围跟侧栏那一列一样（recallOrder：读的是侧栏此刻
 * 画出来的样子，跟 J/K 同一个来源）；右边是选中那一条里我说过的每一句，旧的在前，跟会话一个方向，
 * 打开时停在最近那句，往上滚接着读更早的。
 *
 * 上面那一栏打几个字：左边只留标题对得上、或者我在里面说过对得上的话的任务，右边落到第一句对得上的。
 * 点一句就进那个任务、落到那一颗气泡上；点右边的任务名（或回车、双击左边那行）只进任务。
 *
 * 为什么不是「所有发言按时间一字排开」：试过，一屏几十句来自几十个任务，扫一眼认不出哪句是哪儿的，
 * 比翻侧栏还乱。人记得的往往先是「在哪个任务里」，再是「说了什么」。
 */
export function RecallDialog({
  open,
  fallbackOrder,
  tasks,
  projects,
  currentTaskId,
  onClose,
  onTask,
  notify,
}: {
  open: boolean;
  /** 侧栏的模型顺序（spreadVisibleTasks）：侧栏没画出来的那些、或者整栏收起时用它。 */
  fallbackOrder: readonly TaskListItem[];
  tasks: readonly TaskListItem[];
  projects: readonly ProjectView[];
  /** 主区开着的那一条：打开时先选中它（或收着它的那一行）。 */
  currentTaskId: string | null;
  onClose: () => void;
  onTask: (task: TaskListItem) => void;
  notify: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  // 打开那一下侧栏的样子：开着窗口时不跟着侧栏变（列表在手底下挪动，选中会跳）。
  const [screen, setScreen] = useState<SidebarRowOrder>({ kind: "offscreen" });
  // 搜索还没跟上输入时按了回车：记着按下那一刻的词，等结果跟上了再开（判据见 openDecision）。
  const [enterQueued, setEnterQueued] = useState<string | null>(null);
  // 第几次打开。打开动作要先读任务（手里没有那一条）时，读回来那一刻窗口已经重开过，就不再跳。
  const generation = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const order = useMemo(() => recallOrder(screen, fallbackOrder, tasks), [fallbackOrder, screen, tasks]);
  const members = useMemo(() => recallMembers(order, tasks), [order, tasks]);
  const workers = useMemo(() => indexWorkers([...tasks]), [tasks]);
  const hits = useRecallHits(open, query);
  const rows = useMemo(
    () => recallTaskRows(order, members, (id) => byId.get(id)?.title ?? "", hits.query, hits.hits),
    [byId, hits, members, order],
  );
  const active = rows.find((row) => row.task.id === activeId) ?? rows[0] ?? null;

  useEffect(() => {
    // 关窗口、开窗口都把没开成的回车扔掉：它属于上一次打开。
    setEnterQueued(null);
    if (!open) return;
    generation.current += 1;
    const opened = sidebarRowOrder();
    setScreen(opened);
    setQuery("");
    const home = currentTaskId ? [...recallMembers(recallOrder(opened, fallbackOrder, tasks), tasks)].find(([, ids]) => ids.includes(currentTaskId))?.[0] : undefined;
    setActiveId(home ?? null);
    window.setTimeout(() => input.current?.focus(), 0);
    // 只在打开那一下认侧栏和「当前开着哪条」：开着窗口时列表变了不该把选中拽回去。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // 换了一批结果（查询变了）从第一行重来。
  useEffect(() => { if (hits.query) setActiveId(null); }, [hits.query]);

  useDismissable({ enabled: open, containerRef: panel, onClose });

  // 选中行跟着键盘走进视线；`nearest`：已经看得见的行一动不动（同 ⌘K）。
  useLayoutEffect(() => {
    if (active) list.current?.querySelector(`[data-recall-task="${active.task.id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const gate = { open, pending: hits.pending, query };
  const openTask = (taskId: string, message?: UserMessage) => {
    if (openDecision(gate) !== "open") return;
    const mine = generation.current;
    onClose();
    void Promise.resolve().then(async () => {
      const task = byId.get(taskId) ?? await api.task(taskId);
      if (generation.current !== mine) return;
      if (message) {
        requestMessageReveal({
          taskId,
          sessionId: message.sessionId,
          index: message.index,
          at: message.at,
          text: message.text,
          truncated: message.truncated,
        });
      }
      onTask(task);
    }).catch((error: unknown) => notify(error instanceof Error ? error.message : "这个任务打不开了"));
  };

  useEffect(() => {
    if (enterQueued === null) return;
    const decision = openDecision(gate, enterQueued);
    if (decision === "wait") return;
    setEnterQueued(null);
    if (decision === "open" && active) openTask(active.task.id);
    // 只在窗口开关、结果跟上、词又改了这几下判：active 是那一刻新结果里的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enterQueued, hits.pending, open, query]);

  if (!open) return null;

  const move = (step: number) => {
    if (!rows.length) return;
    const at = active ? rows.indexOf(active) : 0;
    setActiveId(rows[Math.max(0, Math.min(rows.length - 1, at + step))]!.task.id);
  };
  const empty = order.length === 0 ? "侧栏里还没有任务"
    : hits.query ? (hits.error ? "没有标题对得上的任务" : "没有对得上的任务") : "";

  return (
    <div className="overlay-scrim recall-scrim" role="presentation">
      <section ref={panel} className="recall" role="dialog" aria-modal="true" aria-label="我说过的话">
        <div className="recall-input">
          <MagnifyingGlass size={18} className="shrink-0" aria-hidden="true" />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="任务名，或我说过的话"
            aria-label="筛选任务和我说过的话"
            aria-controls="recall-list"
            aria-activedescendant={active ? `recall-task-${active.task.id}` : undefined}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown") move(1);
              else if (event.key === "ArrowUp") move(-1);
              else if (event.key === "PageDown") move(8);
              else if (event.key === "PageUp") move(-8);
              else if (event.key === "Enter") {
                const decision = openDecision(gate);
                if (decision === "wait") setEnterQueued(query.trim());
                else if (decision === "open" && active) openTask(active.task.id);
              } else return;
              event.preventDefault();
            }}
          />
          {hits.pending && <span className="recall-searching" role="status">搜索中…</span>}
        </div>
        <div className="recall-body">
          <div
            ref={list}
            id="recall-list"
            className="recall-list"
            role="listbox"
            aria-label="任务"
            aria-busy={hits.pending}
            data-stale={hits.pending ? "" : undefined}
          >
            {hits.error && (
              <div role="alert" className="recall-error recall-error--inline">
                <span>正文没搜成，下面只按任务名筛：{hits.error}</span>
                <button type="button" onClick={hits.retry}>重试</button>
              </div>
            )}
            {rows.map((row) => (
              <div
                key={row.task.id}
                id={`recall-task-${row.task.id}`}
                role="option"
                aria-selected={row === active}
                data-recall-task={row.task.id}
                className="recall-task"
                // 指针真的动了才换选中：列表滚动时从指针底下滑过去的行不算（不用 mouseenter）。
                onPointerMove={() => { if (row !== active) setActiveId(row.task.id); }}
                onClick={() => setActiveId(row.task.id)}
                onDoubleClick={() => openTask(row.task.id)}
              >
                <span className="recall-task-mark"><RowMark look={taskLook(row.task, workersFrom(workers, row.task.id))} small /></span>
                <span className="recall-task-title"><Highlighted text={row.task.title} query={hits.query} /></span>
                {hits.query && row.hits > 0 && <span className="recall-task-hits">{row.hits}</span>}
              </div>
            ))}
            {!rows.length && empty && <p className="recall-empty">{empty}</p>}
          </div>
          {active && (
            <Messages
              row={active}
              open={open}
              query={hits.query}
              titleOf={(id) => byId.get(id)?.title ?? "已删除的任务"}
              project={projects.find((project) => project.id === active.task.projectId)?.name}
              onTask={openTask}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function Messages({
  row,
  open,
  query,
  titleOf,
  project,
  onTask,
}: {
  row: RecallTaskRow;
  open: boolean;
  query: string;
  titleOf: (taskId: string) => string;
  project: string | undefined;
  onTask: (taskId: string, message?: UserMessage) => void;
}) {
  const { data, error, loadOlder, retry } = useRecallMessagesOf(open, row.task.id, row.members);
  const scroller = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => data ? recallBlocks(data.messages, row.task.id) : [], [data, row.task.id]);
  const fileName = (path: string) => attachmentView(path).name;
  const hasHit = !!query && !!data?.messages.some((message) => messageMatches(message.text, query));
  // 这一行、这一问落过地没有。落地之前不往前接页（滚动条还在最上面，顶上那个哨兵一直看得见）；
  // 落地之后往前接的那页加在上面，原来看着的那几句不许跟着跳走。
  const landed = useRef<string | null>(null);
  const landing = `${row.task.id}|${query}`;
  const keep = useRef<{ height: number; top: number; count: number } | null>(null);

  // 搜的那句在更早的页里（左边说有命中、手里这几页还没有）：一页一页往前接，直到接到或者到头。
  const seeking = !!query && row.hits > 0 && !hasHit && !!data?.older && !data.olderError;
  useEffect(() => {
    if (seeking && !data?.loadingOlder) loadOlder();
  }, [data?.loadingOlder, loadOlder, seeking]);

  // 打开一条：有对得上的话就落到第一句对得上的，没有就停在最底下（最近说的那句），同会话。
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root || !data) return;
    if (landed.current === landing) {
      // 已经落过地：往前接的那页到了，按原来看着的位置补回去（还在读的那一下不算）。
      if (keep.current && data.messages.length !== keep.current.count) {
        root.scrollTop = keep.current.top + (root.scrollHeight - keep.current.height);
        keep.current = null;
      }
      return;
    }
    if (seeking || (query && row.hits > 0 && !hasHit && data.loadingOlder)) return;
    const hit = hasHit ? root.querySelector<HTMLElement>("[data-recall-hit]") : null;
    if (hit) hit.scrollIntoView({ block: "center" });
    else root.scrollTop = root.scrollHeight;
    landed.current = landing;
  }, [data, hasHit, landing, query, row.hits, seeking]);

  // 滚到顶接着往前读。
  useEffect(() => {
    const root = scroller.current;
    const target = top.current;
    if (!root || !target || !data?.older || data.olderError) return;
    const observer = new IntersectionObserver((entries) => {
      if (landed.current !== landing || !entries.some((entry) => entry.isIntersecting)) return;
      keep.current = { height: root.scrollHeight, top: root.scrollTop, count: data.messages.length };
      loadOlder();
    }, { root, rootMargin: "160px 0px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [data?.messages.length, data?.older, data?.olderError, landing, loadOlder]);

  const count = data?.messages.length ?? 0;
  return (
    <aside className="recall-preview" aria-live="polite">
      <header>
        <button type="button" className="recall-preview-task" onClick={() => onTask(row.task.id)}>{row.task.title}</button>
        <p>{[project, data && count ? (data.older ? `最近 ${count} 句` : `${count} 句`) : null].filter(Boolean).join(" · ")}</p>
      </header>
      <div ref={scroller} className="recall-thread">
        {error ? (
          <div role="alert" className="recall-error">
            <span>{error}</span>
            <button type="button" onClick={retry}>重试</button>
          </div>
        ) : !data ? (
          <p className="recall-empty">正在读…</p>
        ) : !count ? (
          <p className="recall-empty">这里还没说过话</p>
        ) : (
          <>
            <div ref={top} className="recall-older" aria-hidden={!data.older && !data.olderError}>
              {data.olderError ? (
                <span role="alert" className="recall-error">
                  <span>更早的没读出来：{data.olderError}</span>
                  <button type="button" onClick={retry}>重试</button>
                </span>
              ) : data.loadingOlder ? "正在读更早的…" : null}
            </div>
            {blocks.map((block) => {
              if (block.kind === "day") return <div key={block.key} className="recall-day">{block.label}</div>;
              if (block.kind === "task") return <div key={block.key} className="recall-where">{titleOf(block.taskId)}</div>;
              const { message } = block;
              return (
                <button
                  key={block.key}
                  type="button"
                  className="recall-mine"
                  data-recall-hit={messageMatches(message.text, query) ? "" : undefined}
                  onClick={() => onTask(message.taskId, message)}
                >
                  <time dateTime={message.at}>{clockOf(message.at)}</time>
                  {/* 引文照会话气泡的长相：淡一档、左边一道竖线（MessageText），不露裸的 `>`。 */}
                  {splitMessageQuotes(message.text).map((part, index) => (
                    <p key={index} className={part.kind === "quote" ? "recall-quote" : undefined}><Highlighted text={part.text} query={query} /></p>
                  ))}
                  {message.attachments.length > 0 && (
                    <ul>
                      {message.attachments.map((path) => <li key={path}><Paperclip size={12} aria-hidden="true" />{fileName(path)}</li>)}
                    </ul>
                  )}
                </button>
              );
            })}
          </>
        )}
      </div>
    </aside>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const parts: ReactNode[] = highlightParts(text, query).map((part, index) =>
    part.hit ? <mark key={index}>{part.text}</mark> : part.text);
  return <>{parts}</>;
}
