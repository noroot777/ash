import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MagnifyingGlass, Paperclip } from "@phosphor-icons/react";
import type { ProjectView, TaskListItem } from "@ash/shared";
import type { UserMessage, UserMessageTask } from "@ash/shared/user-messages";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import { api } from "../lib/api.ts";
import { deriveTaskStatusIndicator } from "../lib/taskLook.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { requestMessageReveal } from "../search/messageReveal.ts";
import { attachmentView } from "../task-detail/utils.ts";
import { clockOf, fullInstant, highlightParts, recallRows, rowText } from "./recallModel.ts";
import { useRecallMessages } from "./useRecallMessages.ts";
import "../styles/recall.css";

/** 选中行离列表底部还有这么几行时就去接下一页，按着 ↓ 不会撞到底停住。 */
const PREFETCH_ROWS = 8;
/** PageUp / PageDown 一下挪几行。 */
const PAGE_ROWS = 8;

type TaskInfo = { title: string; projectId: string; archived: boolean; live: TaskListItem | null };

/**
 * R 键：我在所有任务里说过的每一句话，新的在前。左边一句一行，右边是选中那句的全文和它所在的任务；
 * 点一下（或回车）就进那个任务、落到那一颗气泡上。
 *
 * 跟 ⌘K 的分工：⌘K 从「任务」找起，要先想得起关键词；这里从「我说过什么」找起，翻着时间线认得出
 * 就行，记得几个字再打进上面那一栏筛。
 */
export function RecallDialog({
  open,
  tasks,
  projects,
  currentProjectId,
  onClose,
  onTask,
  onArchive,
  notify,
}: {
  open: boolean;
  tasks: readonly TaskListItem[];
  projects: readonly ProjectView[];
  currentProjectId: string | null;
  onClose: () => void;
  onTask: (task: TaskListItem) => void;
  /** 归档的任务没有会话可落，去的是归档页（同 ⌘K）。 */
  onArchive: () => void;
  notify: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const data = useRecallMessages(open, query);
  const rows = useMemo(() => recallRows(data.messages), [data.messages]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    window.setTimeout(() => input.current?.focus(), 0);
  }, [open]);
  // 换了一批结果（查询变了）从第一行重来；接上下一页不算，选中行原地不动。
  useEffect(() => setActive(0), [data.query]);

  useDismissable({ enabled: open, containerRef: panel, onClose });

  const liveById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const workersOf = useMemo(() => {
    const byParent = new Map<string, TaskListItem[]>();
    for (const task of tasks) if (task.parentId) byParent.set(task.parentId, [...byParent.get(task.parentId) ?? [], task]);
    return byParent;
  }, [tasks]);
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  // 手里有实时的那份就用实时的（状态跟着变），没有（归档的、列表还没读到的）用服务端随页带来的。
  const infoOf = (taskId: string): TaskInfo | null => {
    const live = liveById.get(taskId);
    if (live) return { title: live.title, projectId: live.projectId, archived: !!live.archived, live };
    const sent: UserMessageTask | undefined = data.tasks.get(taskId);
    return sent ? { title: sent.title, projectId: sent.projectId, archived: sent.archived, live: null } : null;
  };

  // 选中行跟着键盘走进视线；`nearest`：已经看得见的行一动不动（同 ⌘K）。
  useLayoutEffect(() => {
    list.current?.querySelector(`[data-recall-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // 滚到底、或者按着 ↓ 快到底了，接下一页。
  const { more } = data;
  useEffect(() => {
    const root = list.current;
    const target = sentinel.current;
    if (!open || !root || !target) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) more();
    }, { root, rootMargin: "240px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [more, open, rows.length]);
  useEffect(() => {
    if (open && active >= rows.length - PREFETCH_ROWS) more();
  }, [active, more, open, rows.length]);

  if (!open) return null;

  const openMessage = (message: UserMessage | undefined) => {
    if (!message) return;
    const info = infoOf(message.taskId);
    onClose();
    void Promise.resolve().then(async () => {
      const task = info?.live ?? await api.task(message.taskId);
      const archived = info?.archived ?? !!task.archived;
      if (!archived) {
        requestMessageReveal({
          taskId: message.taskId,
          sessionId: message.sessionId,
          index: message.index,
          at: message.at,
          text: message.text,
          truncated: message.truncated,
        });
      }
      onTask(task);
      if (archived) onArchive();
    }).catch((error: unknown) => notify(error instanceof Error ? error.message : "这个任务打不开了"));
  };

  const move = (step: number) => {
    if (!rows.length) return;
    setActive((value) => Math.max(0, Math.min(rows.length - 1, value + step)));
  };
  const selected = rows[active]?.message;
  const fileName = (path: string) => attachmentView(path).name;
  const empty = data.loading && !rows.length ? "正在读…"
    : data.query ? "没有对得上的话" : "还没有说过话";

  return (
    <div className="overlay-scrim recall-scrim" role="presentation">
      <section ref={panel} className="recall" role="dialog" aria-modal="true" aria-label="我说过的话">
        <div className="recall-input">
          <MagnifyingGlass size={18} className="shrink-0" aria-hidden="true" />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="我说过的话"
            aria-label="筛选我说过的话"
            aria-controls="recall-list"
            aria-activedescendant={selected ? `recall-row-${active}` : undefined}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown") move(1);
              else if (event.key === "ArrowUp") move(-1);
              else if (event.key === "PageDown") move(PAGE_ROWS);
              else if (event.key === "PageUp") move(-PAGE_ROWS);
              else if (event.key === "Enter") openMessage(selected);
              else return;
              event.preventDefault();
            }}
          />
        </div>
        <div className="recall-body">
          <div ref={list} id="recall-list" className="recall-list" role="listbox" aria-label="我说过的话">
            {rows.map(({ message, index, day }) => {
              const info = infoOf(message.taskId);
              const project = info && info.projectId !== currentProjectId ? projectNames.get(info.projectId) : undefined;
              return (
                <div key={message.id} role="presentation">
                  {day && <div className="recall-day" role="presentation">{day}</div>}
                  <div
                    id={`recall-row-${index}`}
                    role="option"
                    aria-selected={index === active}
                    data-recall-index={index}
                    className="recall-row"
                    // 指针真的动了才换选中：列表滚动时从指针底下滑过去的行不算（不用 mouseenter）。
                    onPointerMove={() => { if (index !== active) setActive(index); }}
                    onClick={() => openMessage(message)}
                  >
                    <p><Highlighted text={rowText(message, fileName, data.query)} query={data.query} /></p>
                    <div className="recall-row-meta">
                      {info?.live && <StatusOf task={info.live} workers={workersOf.get(info.live.id)} />}
                      <span className="recall-row-task">{info?.title ?? "已删除的任务"}</span>
                      {project && <span className="recall-row-project">{project}</span>}
                      {info?.archived && <span className="recall-row-project">已归档</span>}
                      <time dateTime={message.at}>{clockOf(message.at)}</time>
                    </div>
                  </div>
                </div>
              );
            })}
            {!rows.length && !data.error && <p className="recall-empty">{empty}</p>}
            {data.error && (
              <div role="alert" className="recall-error">
                <span>{data.error}</span>
                <button type="button" onClick={data.retry}>重试</button>
              </div>
            )}
            <div ref={sentinel} className="recall-sentinel" aria-hidden="true" />
            {data.loadingMore && <p className="recall-empty">正在读更早的…</p>}
          </div>
          {selected && <Preview message={selected} info={infoOf(selected.taskId)} projectName={projectNames} query={data.query} fileName={fileName} onOpen={() => openMessage(selected)} />}
        </div>
      </section>
    </div>
  );
}

function StatusOf({ task, workers }: { task: TaskListItem; workers?: TaskListItem[] }) {
  const indicator = deriveTaskStatusIndicator(task, workers);
  return indicator ? <TaskStatusDot indicator={indicator} surface="workspace" small /> : null;
}

function Preview({
  message,
  info,
  projectName,
  query,
  fileName,
  onOpen,
}: {
  message: UserMessage;
  info: TaskInfo | null;
  projectName: Map<string, string>;
  query: string;
  fileName: (path: string) => string;
  onOpen: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // 换了一句就从头读起。
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [message.id]);
  return (
    <aside className="recall-preview" aria-live="polite">
      <button type="button" className="recall-preview-task" onClick={onOpen}>{info?.title ?? "已删除的任务"}</button>
      <div className="recall-preview-meta">
        {info && <span>{projectName.get(info.projectId) ?? ""}</span>}
        {info?.archived && <span>已归档</span>}
        <time dateTime={message.at}>{fullInstant(message.at)}</time>
      </div>
      <div ref={scroller} className="recall-preview-text">
        {message.text && <p><Highlighted text={message.text} query={query} /></p>}
        {message.attachments.length > 0 && (
          <ul className="recall-preview-files">
            {message.attachments.map((path) => <li key={path}><Paperclip size={12} aria-hidden="true" />{fileName(path)}</li>)}
          </ul>
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
