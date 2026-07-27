import { useState, useEffect, useLayoutEffect, useRef } from "react";
import type { Priority, Session, ProjectHealth, ProjectView, Task } from "@harness/shared";
import { Plus, CaretRight, CaretDown, GitBranch, Copy, Check, ArrowBendDownRight } from "@phosphor-icons/react";
import { shortPath } from "./util";
import { Duration, formatInstant } from "./time";
import { api } from "./api";

// Remember which sections of a status-grouped list the user folded away, keyed
// per list so the choice survives reloads (localStorage). Shared by the task
// list (完成/失败/…) and the issue list (进行中/待办/…) so both fold identically.
export function useCollapsedGroups(storageKey: string) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        /* private mode / quota — folding just won't persist */
      }
      return next;
    });
  return { collapsed, toggle };
}

// Long free-text (a task's objective / a debate's topic) that would otherwise
// dominate the header: clamp to two lines by default, with an icon-only toggle
// floating in the box's top-right corner (no separate row) — shown only when the
// text actually overflows. Expanded, it's a scrollable box rather than an
// unbounded wall. Shared by the task detail and the debate header so both read
// the same.
export function CollapsibleText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  // Measure in the clamped state (scrollHeight > clientHeight ⇒ there's more to
  // show). Re-measure on text change; skip while open (clientHeight grows then).
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);
  const toggleable = overflows || open;
  return (
    <div className="relative mt-2">
      <p
        ref={ref}
        onClick={() => !open && overflows && setOpen(true)}
        className={`whitespace-pre-wrap break-words rounded-md bg-raised/60 px-3 py-2 text-[13px] text-muted ${
          toggleable ? "pr-9" : ""
        } ${open ? "max-h-48 overflow-y-auto" : `line-clamp-2 ${overflows ? "cursor-pointer" : ""}`}`}
      >
        {text}
      </p>
      {toggleable && (
        <button
          onClick={() => setOpen((o) => !o)}
          title={open ? "收起" : "展开全文"}
          aria-label={open ? "收起" : "展开全文"}
          className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-md text-faint transition-colors hover:bg-line2 hover:text-muted"
        >
          <CaretDown size={13} weight="bold" className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      )}
    </div>
  );
}


// "⏱ 14m 3s" with the start/end instants in the tooltip — the session-run timing
// attached to a credential. This is always a FINISHED run's timing (footers live
// in history / debate transcripts), so it never ticks: a row with no recorded end
// (legacy, or interrupted before ended_at was written) shows its start instant
// rather than spinning a counter up to "now".
export function SessionTime({ s }: { s: Session }) {
  if (!s.startedAt) return null;
  if (!s.endedAt) {
    return (
      <span className="text-faint" title={`开始 ${formatInstant(s.startedAt)}（未记录结束）`}>
        ⏱ {formatInstant(s.startedAt)} 起
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-faint" title={`开始 ${formatInstant(s.startedAt)} · 结束 ${formatInstant(s.endedAt)}`}>
      ⏱ <Duration from={s.startedAt} to={s.endedAt} />
    </span>
  );
}

// Collapsible tool-call block (Claude-desktop style): a compact one-line summary
// by default, click to expand the full command/input. Shared by the task log and
// debate bubbles so both read the same.
export function ToolCall({ name, detail }: { name: string; detail?: string }) {
  const [open, setOpen] = useState(false);
  const has = !!detail?.trim();
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => has && setOpen((o) => !o)}
        className={`inline-flex max-w-full items-center gap-1 rounded-md bg-raised px-2 py-0.5 text-[11px] text-amber-700/90 ${has ? "hover:bg-overlay" : "cursor-default"}`}
      >
        <CaretRight size={10} weight="bold" className={`shrink-0 transition-transform ${open ? "rotate-90" : ""} ${has ? "" : "opacity-0"}`} />
        <span className="font-mono">⚙ {name}</span>
        {has && !open && <span className="truncate font-mono text-faint">{detail!.replace(/\s+/g, " ").slice(0, 80)}</span>}
      </button>
      {open && has && (
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-raised px-2.5 py-1.5 font-mono text-[11px] leading-snug text-muted">{detail}</pre>
      )}
    </div>
  );
}

// Collapsible "thinking" block — hidden by default, expand to read.
export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-faint hover:bg-raised"
      >
        <CaretRight size={10} weight="bold" className={`transition-transform ${open ? "rotate-90" : ""}`} />
        思考{open ? "" : "…"}
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap break-words border-l-2 border-line pl-3 text-[12px] italic text-faint">{text}</div>
      )}
    </div>
  );
}

// repoPath health at a glance: 🔴 路径不存在 / 🟡 存在但非 git 仓库 / 🟢 git 仓库.
const HEALTH_RED = "#eb5757";
const HEALTH_AMBER = "#e2a33b";
const HEALTH_GREEN = "#3fae6b";
export function healthColor(h?: ProjectHealth): string {
  if (!h || !h.exists) return HEALTH_RED;
  if (!h.isRepo) return HEALTH_AMBER;
  return HEALTH_GREEN;
}
export function healthLabel(h?: ProjectHealth): string {
  if (!h || !h.exists) return "路径不存在";
  if (!h.isRepo) return "目录存在，但不是 git 仓库——任务可正常运行";
  let s = h.isWorktree ? "git worktree" : "git 仓库";
  if (h.branch) s += ` · ${h.branch}`;
  if (h.dirty) s += " · 有改动";
  return s;
}
export function HealthDot({ health, size = 8 }: { health?: ProjectHealth; size?: number }) {
  return (
    <span
      aria-hidden
      title={healthLabel(health)}
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, backgroundColor: healthColor(health) }}
    />
  );
}

// Current git context of a project's working dir: the branch, a dot when the tree
// is dirty, and a quiet "worktree" tag when the dir is itself a linked worktree.
// harness no longer creates worktrees — this only REPORTS what the user set up, so
// they can see at a glance which branch (and whether a worktree) work lands on.
// Sits unobtrusively in the top bar next to the project switcher.
export function BranchChip({ health }: { health?: ProjectHealth | null }) {
  if (!health?.isRepo || !health.branch) return null;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 text-[12px] text-muted"
      title={`分支 ${health.branch}${health.isWorktree ? "（worktree）" : ""}${health.dirty ? " · 有未提交改动" : ""}`}
    >
      <GitBranch size={12} className="shrink-0 text-faint" />
      <span className="max-w-[180px] truncate">{health.branch}</span>
      {health.dirty && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />}
      {health.isWorktree && (
        <span className="shrink-0 rounded bg-raised px-1 py-px text-[10px] text-faint">worktree</span>
      )}
    </span>
  );
}

// A project's color + initial avatar. A deterministic color from the name gives
// each project a stable visual identity in the switcher (trigger + rows), so you
// scan by color, not just text. Shared so the trigger and list never mismatch.
const AVATAR_COLORS = ["#6366f1", "#8b5cf6", "#d946ef", "#ec4899", "#f43f5e", "#f59e0b", "#10b981", "#06b6d4", "#0ea5e9", "#14b8a6"];
export function projectColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
export function ProjectAvatar({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-md font-semibold text-white"
      style={{ width: size, height: size, backgroundColor: projectColor(name), fontSize: Math.round(size * 0.46) }}
    >
      {(name || "·").slice(0, 1).toUpperCase()}
    </span>
  );
}

// Live path validation line — debounce-checks a typed repoPath via the backend
// and renders the dot + verdict. Shared by 新建项目 and 项目设置.
export function PathHealth({ path }: { path: string }) {
  const [health, setHealth] = useState<ProjectHealth | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const p = path.trim();
    if (!p) {
      setHealth(null);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      api
        .checkPath(p)
        .then((h) => setHealth(h))
        .catch(() => setHealth(null))
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(t);
  }, [path]);
  if (!path.trim())
    return (
      <span className="text-[12px] text-faint">
        未填写工作目录——每个任务各自在独立临时目录（data/scratch/任务 ID）运行，彼此看不到产物；之后可在项目设置中补填
      </span>
    );
  if (health)
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
        <HealthDot health={health} />
        {healthLabel(health)}
        {!health.exists && (
          <span className="text-faint">（不会自动创建该目录；每个任务将使用独立临时目录 data/scratch/任务 ID）</span>
        )}
      </span>
    );
  return <span className="text-[12px] text-faint">{loading ? "校验中…" : ""}</span>;
}

// "Where will this run" line for the create / debate modals: health dot + path +
// the repo's current branch (fetched fresh, since the list health is lightweight
// and has no branch). Warns when the path is missing (→ scratch dir).
export function RunLocation({ project }: { project: ProjectView }) {
  const [full, setFull] = useState<ProjectHealth | null>(null);
  useEffect(() => {
    setFull(null);
    if (project.health.isRepo) api.projectHealth(project.id).then(setFull).catch(() => {});
  }, [project.id, project.health.isRepo]);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <HealthDot health={full ?? project.health} size={7} />
      <span className="font-mono text-faint" title={project.repoPath}>
        将在 {shortPath(project.repoPath) || "（未设置工作目录）"} 运行
      </span>
      {full?.branch && <span className="text-muted">· 分支 {full.branch}</span>}
      {!project.health.exists && (
        <span className="text-amber-600">
          {project.repoPath.trim()
            ? "· 目录不存在，不会自动创建该目录；本任务将使用独立临时目录（data/scratch/任务 ID）"
            : "· 未填写工作目录；本任务将使用独立临时目录（data/scratch/任务 ID），其他任务看不到其中产物"}
        </span>
      )}
    </div>
  );
}

// Linear-style priority glyph: three ascending bars (filled by level) for
// none/low/medium/high, and an amber square with "!" for urgent. Both variants
// occupy the full 14×14 box and read at similar visual weight so a list of
// mixed priorities doesn't look like icons of different sizes.
export function PriorityIcon({ p }: { p: Priority }) {
  if (p === "urgent")
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="shrink-0">
        <rect x="1.5" y="1.5" width="11" height="11" rx="3" fill="#fc7840" />
        <rect x="6.4" y="3.6" width="1.2" height="4.4" rx="0.6" fill="#fff" />
        <rect x="6.4" y="9.2" width="1.2" height="1.4" rx="0.6" fill="#fff" />
      </svg>
    );
  const levels = { none: 0, low: 1, medium: 2, high: 3 } as const;
  const n = levels[p as keyof typeof levels] ?? 0;
  // Bottom-aligned at y=13; heights step 4 / 7 / 10 for a clear ascending shape.
  const bars = [
    { x: 1, h: 4 },
    { x: 5.5, h: 7 },
    { x: 10, h: 10 },
  ];
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="shrink-0">
      {bars.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={13 - b.h}
          width="3"
          height={b.h}
          rx="0.75"
          fill={i < n ? "#4b5563" : "#c5c8cf"}
        />
      ))}
    </svg>
  );
}

// Inline label adder (replaces prompt()): click reveals an input, Enter adds.
export function LabelAdder({ onAdd }: { onAdd: (label: string) => void }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState("");
  if (!open)
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted hover:bg-raised hover:text-ink"
      >
        <Plus size={12} weight="bold" /> 标签
      </button>
    );
  return (
    <input
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        setOpen(false);
        setV("");
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && v.trim()) {
          onAdd(v.trim());
          setV("");
          setOpen(false);
        } else if (e.key === "Escape") {
          setOpen(false);
          setV("");
        }
      }}
      placeholder="标签名 ↵"
      className="w-24 rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-ink outline-none placeholder:text-faint focus:border-accent"
    />
  );
}

// The two copy buttons of a run credential (resume command + session id), on
// their own so a bubble footer can show them without the SessionTime (which the
// task bubble now renders in its header instead).
export function ResumeCopyButtons({ s }: { s: Session }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, text: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1200);
  };
  return (
    <>
      <button
        onClick={() => copy("cmd", s.resumeCommand ?? "")}
        className="rounded bg-overlay px-1.5 py-0.5 text-muted hover:text-ink disabled:opacity-40"
        disabled={!s.resumeCommand}
        title={s.resumeCommand ?? ""}
      >
        {copied === "cmd" ? "已复制" : "复制 resume 命令"}
      </button>
      <button
        onClick={() => copy("id", s.cliSessionId ?? "")}
        className="rounded bg-overlay px-1.5 py-0.5 text-muted hover:text-ink disabled:opacity-40"
        disabled={!s.cliSessionId}
        title={s.cliSessionId ?? ""}
      >
        {copied === "id" ? "✓" : "ID"}
      </button>
    </>
  );
}

// Slim per-speech variant — SessionTime + the two copy buttons, to sit in a debate
// bubble footer where the role/agent are already shown.
export function ResumeButtons({ s }: { s: Session }) {
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
      <SessionTime s={s} />
      <ResumeCopyButtons s={s} />
    </div>
  );
}

// Generic copy-to-clipboard icon button: writes `text`, then flips to a ✓ for
// 1.2s. Sizing / rounding / hover all come from `className` so it works equally as
// a header action and as a hover-reveal affordance inside a conversation bubble.
export function CopyButton({
  text,
  title = "复制",
  className = "",
  size = 13,
}: {
  text: string;
  title?: string;
  className?: string;
  size?: number;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={done ? "已复制" : title}
      onClick={(e) => {
        e.stopPropagation();
        if (!text) return;
        navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className={`grid place-items-center rounded-md text-faint transition hover:text-ink ${className}`}
    >
      {done ? <Check size={size} weight="bold" className="text-emerald-600" /> : <Copy size={size} />}
    </button>
  );
}

// PauseHint —— paused 状态卡片的"等谁"副标行（TaskList 使用）。
// 队列模型版(DESIGN-scheduling.md):paused 任务在 queue 里等"前面所有项 done/canceled"。
// 看 task.queueId / queuePosition,从 allTasks 里找同 queue 排在前面的、还没让位的项。
//   • 至少一个未让位前驱 → "↳ 等「标题」"(+N 如果还有更多)
//   • 全部前驱都 done/canceled 或自己是队首 → "等待续跑"(瞬时态,scheduler 一轮就唤起)
// 点击跳到第一个阻塞任务。
export function PauseHint({
  task,
  allTasks,
  onOpen,
}: {
  task: Task;
  allTasks: Task[];
  onOpen?: (id: string) => void;
}) {
  if (task.status !== "paused") return null;
  // 没在队列里(罕见:paused 但不在 queue),也算"等待续跑"
  const queueMates = task.queueId
    ? allTasks
        .filter((t) => t.queueId === task.queueId)
        .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
    : [];
  const myIdx = queueMates.findIndex((t) => t.id === task.id);
  const blockers = (myIdx >= 0 ? queueMates.slice(0, myIdx) : []).filter(
    (t) => t.status !== "done" && t.status !== "canceled",
  );
  const first = blockers[0];
  const extra = blockers.length - 1;
  const click = (e: React.MouseEvent) => {
    if (!first || !onOpen) return;
    e.stopPropagation();
    onOpen(first.id);
  };
  return (
    <div
      className="mt-1.5 flex items-center gap-1 text-[11px] text-slate-500"
      title={
        blockers.map((t) => `${t.title} · ${t.status}`).join("\n") ||
        "等待 scheduler 续跑(队首,前置已全部让位)"
      }
    >
      <ArrowBendDownRight size={11} className="shrink-0 opacity-70" />
      {first ? (
        <>
          <span className="shrink-0">等</span>
          <button
            type="button"
            onClick={click}
            className="-mx-1 min-w-0 max-w-[18rem] truncate rounded px-1 text-left hover:bg-slate-500/10 hover:text-slate-700"
          >
            「{first.title}」
            {first.status === "paused" && <span className="ml-1 opacity-70">(也在等)</span>}
          </button>
          {extra > 0 && <span className="shrink-0 opacity-70">+{extra}</span>}
        </>
      ) : (
        <span className="opacity-80">等待续跑</span>
      )}
    </div>
  );
}

// Drag handle for a sidebar's right edge. The parent owns the width (so it can
// persist it); this just reports new values via onChange, clamped to [min, max].
// Straddles the border for an easy grab target; double-click resets. The drag is
// tracked on window so it keeps following the cursor outside the thin handle.
export function ResizeHandle({
  width,
  onChange,
  min = 220,
  max = 560,
  resetWidth = 300,
}: {
  width: number;
  onChange: (w: number) => void;
  min?: number;
  max?: number;
  resetWidth?: number;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!start.current) return;
      const w = Math.min(max, Math.max(min, start.current.w + (e.clientX - start.current.x)));
      onChange(w);
    };
    const up = () => {
      if (!start.current) return;
      start.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [min, max, onChange]);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="拖动调整宽度（双击重置）"
      onMouseDown={(e) => {
        e.preventDefault();
        start.current = { x: e.clientX, w: width };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onDoubleClick={() => onChange(resetWidth)}
      className="group absolute right-0 top-0 z-10 h-full w-3 translate-x-1/2 cursor-col-resize before:pointer-events-none before:absolute before:left-1/2 before:top-0 before:h-full before:w-px before:-translate-x-1/2 before:bg-accent/0 before:transition-colors hover:before:bg-accent/70"
    />
  );
}
