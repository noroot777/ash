import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { SearchHit, Task, ProjectView } from "@harness/shared";
import { NotePencil } from "@phosphor-icons/react";
import { api } from "./api";
import { StatusIcon } from "./StatusIcon";
import { formatInstant } from "./time";
import { usePresence } from "./useReveal";

export type Command = {
  id: string;
  label: string;
  hint?: string;
  keys?: string;
  group?: string;
  run: () => void;
};

// Where the match was found — tells the user WHY this hit surfaced (a directory
// name usually lives in the conversation, not the title).
const FIELD_LABEL: Record<SearchHit["field"], string | null> = {
  title: null, // title matches highlight in the title itself, no chip needed
  body: "正文",
  conversation: "会话",
};

// Highlight every occurrence of `q` (case-insensitive) inside `text`.
function Highlight({ text, q }: { text: string; q: string }) {
  const needle = q.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let pos = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, pos)) {
    if (i > pos) parts.push(text.slice(pos, i));
    parts.push(
      <mark key={i} className="rounded-[2px] bg-accent/25 text-inherit">
        {text.slice(i, i + needle.length)}
      </mark>,
    );
    pos = i + needle.length;
  }
  parts.push(text.slice(pos));
  return <>{parts}</>;
}

function SearchPreview({ hit, q }: { hit: SearchHit | undefined; q: string }) {
  if (!hit) {
    return (
      <aside className="grid min-h-0 place-items-center bg-panel/50 px-8 text-center">
        <p className="max-w-[220px] text-xs leading-5 text-faint">选择一条搜索结果，在这里阅读全文</p>
      </aside>
    );
  }

  const previewLabel = hit.kind === "task" ? "任务正文" : "随手记正文";
  const preview = hit.preview ?? "";

  return (
    <aside className="flex min-h-0 flex-col bg-panel/50">
      <div className="shrink-0 border-b border-line px-5 py-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 shrink-0">
            {hit.kind === "task" ? <StatusIcon status={hit.status} /> : <NotePencil size={16} className="text-muted" />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium leading-5 text-ink">
              <Highlight text={hit.title} q={q} />
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-faint">
              <span>{hit.projectName ?? "未知项目"}</span>
              <span aria-hidden="true">·</span>
              <span>更新于 {formatInstant(hit.updatedAt)}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {hit.kind === "task" && hit.field === "conversation" && hit.snippet && (
          <section className="mb-4 rounded-lg border border-line bg-raised/70 p-3">
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-faint">会话命中</div>
            <p className="break-words font-mono text-[11px] leading-5 text-muted">
              <Highlight text={hit.snippet} q={q} />
            </p>
          </section>
        )}
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-faint">{previewLabel}</div>
        {preview ? (
          <div className="whitespace-pre-wrap break-words text-[13px] leading-6 text-muted">
            <Highlight text={preview} q={q} />
          </div>
        ) : (
          <p className="text-xs text-faint">暂无正文</p>
        )}
      </div>
    </aside>
  );
}

export function CommandPalette({
  open,
  commands,
  runningTasks,
  projects,
  onClose,
  onOpenHit,
  onOpenTask,
}: {
  open: boolean;
  commands: Command[];
  runningTasks: Task[];
  projects: ProjectView[];
  onClose: () => void;
  onOpenHit: (hit: SearchHit) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  // Guards against out-of-order responses: only the latest query may land.
  const seqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const { mounted, closing } = usePresence(open, "--modal-close-dur");

  // The palette is the topmost keyboard layer. Capture Esc before the window-level
  // handlers owned by any modal underneath it, so one key closes only the palette.
  useEffect(() => {
    if (!open) return;
    const closeFirst = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", closeFirst, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", closeFirst, true);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      mouseRef.current = null;
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return commands;
    return commands.filter((c) => (c.label + " " + (c.hint ?? "") + " " + (c.keys ?? "") + " " + (c.group ?? "")).toLowerCase().includes(s));
  }, [q, commands]);
  const leadingTasks = q.trim() ? [] : runningTasks;
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);

  // Debounced global task/note search. The server keeps tasks ahead of notes.
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++seqRef.current;
    const timer = setTimeout(() => {
      api
        .search(s)
        .then((r) => {
          if (seqRef.current !== seq) return;
          setHits(r);
          setSearching(false);
        })
        .catch(() => {
          if (seqRef.current !== seq) return;
          setHits([]);
          setSearching(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [q]);

  const total = leadingTasks.length + filtered.length + hits.length;
  useEffect(() => {
    if (active >= total) setActive(0);
  }, [total, active]);

  if (!mounted) return null;

  const run = (c: Command | undefined) => {
    if (!c) return;
    c.run();
    onClose();
  };
  const openHit = (h: SearchHit | undefined) => {
    if (!h) return;
    onOpenHit(h);
    onClose();
  };
  const openRunningTask = (task: Task | undefined) => {
    if (!task) return;
    onOpenTask(task.id);
    onClose();
  };
  const activate = (i: number) => {
    if (i < leadingTasks.length) openRunningTask(leadingTasks[i]);
    else if (i < leadingTasks.length + filtered.length) run(filtered[i - leadingTasks.length]);
    else openHit(hits[i - leadingTasks.length - filtered.length]);
  };
  const hover = (i: number, event: ReactMouseEvent) => {
    const previous = mouseRef.current;
    mouseRef.current = { x: event.clientX, y: event.clientY };
    if (!previous || (previous.x === event.clientX && previous.y === event.clientY)) return;
    setActive(i);
  };
  const hitStart = leadingTasks.length + filtered.length;
  const activeHit = active >= hitStart ? hits[active - hitStart] : undefined;
  const hasHits = hits.length > 0;

  return (
    <div
      className={`t-modal-overlay ${closing ? "is-closing" : ""} fixed inset-0 z-[90] flex items-start justify-center bg-black/50 pt-[15vh]`}
      onClick={onClose}
    >
      <div
        className={`t-modal ${closing ? "is-closing" : ""} ${hasHits ? "w-[860px]" : "w-[560px]"} max-w-[92vw] overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索任务，或输入命令…"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm outline-none placeholder:text-faint"
          onKeyDown={(e) => {
            // 序列快捷键(如 NI/NL)先作为搜索词参与过滤，只有输入精确匹配并按下 Enter 才执行。
            // 这样仍能快速找到命令，也不会抢走以这些字母开头的正常搜索。
            const sequence = e.key === "Enter" && !e.nativeEvent.isComposing
              ? commands.find((command) => command.keys?.replace(/\s+/g, "").toLowerCase() === q.toLowerCase())
              : undefined;
            if (sequence) {
              e.preventDefault();
              run(sequence);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, Math.max(total - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              activate(active);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />
        <div className={hasHits ? "grid h-[50vh] min-h-[320px] grid-cols-[42%_58%]" : "max-h-[50vh] overflow-y-auto"}>
          <div className={hasHits ? "min-h-0 overflow-y-auto border-r border-line py-1" : "py-1"}>
          {leadingTasks.length > 0 && (
            <div className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-faint">进行中</div>
          )}
          {leadingTasks.map((task, index) => (
            <button
              key={task.id}
              onMouseMove={(event) => hover(index, event)}
              onClick={() => openRunningTask(task)}
              className={`flex w-full min-w-0 items-center gap-2 px-4 py-2 text-left text-sm ${index === active ? "bg-overlay" : ""}`}
            >
              <StatusIcon status={task.status} stage={task.stage} awaitingAnswer={!!task.question} />
              <span className="min-w-0 truncate text-ink">{task.title}</span>
              <span className="ml-auto shrink-0 text-xs text-faint">{projectNames.get(task.projectId) ?? "未知项目"}</span>
            </button>
          ))}
          {filtered.map((c, i) => {
            const itemIndex = leadingTasks.length + i;
            // Render a section header whenever the group changes, so current-task
            // actions read separately from global ones.
            const header = c.group && c.group !== filtered[i - 1]?.group ? c.group : null;
            return (
              <div key={c.id}>
                {header && (
                  <div className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-faint">{header}</div>
                )}
                <button
                  onMouseMove={(event) => hover(itemIndex, event)}
                  onClick={() => run(c)}
                  className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm ${
                    itemIndex === active ? "bg-overlay" : ""
                  }`}
                >
                  <span className="text-ink">{c.label}</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {c.keys && (
                      <span className="flex gap-1" aria-label={`快捷键序列 ${c.keys}`}>
                        {c.keys.replace(/\s+/g, "").toUpperCase().split("").map((key, index) => <kbd key={`${key}:${index}`}>{key}</kbd>)}
                      </span>
                    )}
                    {c.hint && <span className="text-xs text-muted">{c.hint}</span>}
                  </span>
                </button>
              </div>
            );
          })}
          {hits.map((h, hi) => {
            const i = leadingTasks.length + filtered.length + hi;
            const header = hi === 0 || hits[hi - 1]?.kind !== h.kind ? (h.kind === "task" ? "任务" : "随手记") : null;
            const fieldChip = FIELD_LABEL[h.field];
            return (
              <div key={`${h.kind}:${h.id}`}>
                {header && (
                  <div className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-faint">{header}</div>
                )}
                <button
                  onMouseMove={(event) => hover(i, event)}
                  onClick={() => openHit(h)}
                  className={`flex w-full flex-col gap-0.5 px-4 py-2 text-left ${i === active ? "bg-overlay" : ""}`}
                >
                  <span className="flex w-full min-w-0 items-center gap-2 text-sm">
                    <span className="shrink-0">
                      {h.kind === "task" ? <StatusIcon status={h.status} /> : <NotePencil size={15} className="text-muted" />}
                    </span>
                    <span className="min-w-0 truncate text-ink">
                      <Highlight text={h.title} q={q} />
                    </span>
                    {h.kind === "task" && h.archived && <span className="shrink-0 rounded bg-overlay px-1 text-[10px] text-faint">已归档</span>}
                    {h.kind === "note" && h.taskId && <span className="shrink-0 rounded bg-overlay px-1 text-[10px] text-faint">已转任务</span>}
                    {h.projectName && <span className="ml-auto shrink-0 text-xs text-faint">{h.projectName}</span>}
                  </span>
                  {h.snippet && (
                    <span className="flex w-full min-w-0 items-center gap-1.5 pl-[22px]">
                      {fieldChip && (
                        <span className="shrink-0 rounded bg-overlay px-1 text-[10px] leading-4 text-faint">{fieldChip}</span>
                      )}
                      <span className="min-w-0 truncate font-mono text-[11px] text-muted">
                        <Highlight text={h.snippet} q={q} />
                      </span>
                    </span>
                  )}
                </button>
              </div>
            );
          })}
          {searching && !hits.length && (
            <p className="px-4 py-2 text-center text-xs text-faint">搜索中…</p>
          )}
          {!total && !searching && (
            <p className="px-4 py-6 text-center text-xs text-faint">
              {q.trim().length >= 2 ? "没有匹配的命令、任务或随手记" : "无匹配命令"}
            </p>
          )}
          </div>
          {hasHits && <SearchPreview hit={activeHit} q={q} />}
        </div>
      </div>
    </div>
  );
}
