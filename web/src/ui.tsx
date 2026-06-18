import { useState, useEffect } from "react";
import type { Priority, Session, ProjectHealth, ProjectView } from "@harness/shared";
import { Plus, CaretRight } from "@phosphor-icons/react";
import { shortPath } from "./util";
import { Duration, formatInstant } from "./time";
import { api } from "./api";

// "⏱ 14m 3s" with the start/end instants in the tooltip — the session-run timing
// (start, end, duration) attached to a credential. Live (ticking) only while the
// run is unfinished; a finished session with no recorded end (legacy row, before
// ended_at existed) falls back to just its start instant rather than ticking on.
function SessionTime({ s }: { s: Session }) {
  if (!s.startedAt) return null;
  if (!s.endedAt && s.exitStatus !== null) {
    return (
      <span className="text-faint" title={`开始 ${formatInstant(s.startedAt)}`}>
        ⏱ {formatInstant(s.startedAt)} 起
      </span>
    );
  }
  const tip = `开始 ${formatInstant(s.startedAt)}${s.endedAt ? ` · 结束 ${formatInstant(s.endedAt)}` : "（进行中）"}`;
  return (
    <span className="inline-flex items-center gap-0.5 text-faint" title={tip}>
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
// One dot, one source of truth — reused in the switcher, create/debate modals,
// and the project settings panel.
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
  if (!h.isRepo) return "存在，但不是 git 仓库";
  let s = "git 仓库";
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
    return <span className="text-[12px] text-faint">未填写路径——运行时将落到临时目录</span>;
  if (health)
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
        <HealthDot health={health} />
        {healthLabel(health)}
        {!health.exists && <span className="text-faint">（运行时将落到临时目录）</span>}
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
    <div className="flex items-center gap-1.5 text-[11px]">
      <HealthDot health={full ?? project.health} size={7} />
      <span className="font-mono text-faint" title={project.repoPath}>
        将在 {shortPath(project.repoPath) || "（未设置路径）"} 运行
      </span>
      {full?.branch && <span className="text-muted">· 分支 {full.branch}</span>}
      {!project.health.exists && <span className="text-amber-600">· 目录不存在，将用临时目录</span>}
    </div>
  );
}

// Linear-style priority glyph: three ascending bars (filled by level), and a
// filled amber square with "!" for urgent.
export function PriorityIcon({ p }: { p: Priority }) {
  if (p === "urgent")
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="#fc7840" />
        <rect x="6.25" y="3.2" width="1.5" height="4.6" rx="0.75" fill="#fff" />
        <rect x="6.25" y="9" width="1.5" height="1.6" rx="0.75" fill="#fff" />
      </svg>
    );
  const levels = { none: 0, low: 1, medium: 2, high: 3 } as const;
  const n = levels[p as keyof typeof levels] ?? 0;
  const bars = [
    { x: 1.5, y: 9, h: 4 },
    { x: 5.5, y: 6, h: 7 },
    { x: 9.5, y: 3, h: 10 },
  ];
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width="3" height={b.h} rx="1" fill={i < n ? "#6b6f76" : "#d6d6dc"} />
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

// Slim per-speech variant — just the two copy buttons (resume command + session
// id), to sit in a debate bubble footer where the role/agent are already shown.
export function ResumeButtons({ s }: { s: Session }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, text: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1200);
  };
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
      <SessionTime s={s} />
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
    </div>
  );
}

// Traceability credential chip — compact: executor + copy-resume + id. The cwd
// and branch live in the executor's hover tooltip to keep it on one line (§13).
export function Credential({ s }: { s: Session }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1200);
  };
  const cwdHint = [s.cwd, s.branch ? `分支 ${s.branch}` : ""].filter(Boolean).join("  ·  ");
  return (
    <div className="inline-flex items-center gap-1.5 rounded-md border border-line bg-raised/50 px-2 py-1 text-[11px]">
      <span className="text-muted" title={cwdHint || s.executor}>{s.executor}</span>
      {s.cwd?.includes("/scratch/") && (
        <span className="text-amber-600" title="临时目录（项目无有效仓库）">⚠</span>
      )}
      <button
        onClick={() => copy("cmd", s.resumeCommand ?? "")}
        className="ml-0.5 rounded bg-overlay px-1.5 py-0.5 text-ink hover:bg-overlay"
        title={s.resumeCommand ?? ""}
      >
        {copied === "cmd" ? "已复制" : "复制 resume"}
      </button>
      <button
        onClick={() => copy("id", s.cliSessionId ?? "")}
        className="rounded bg-overlay px-1.5 py-0.5 text-muted hover:bg-overlay"
        title={s.cliSessionId ?? ""}
      >
        {copied === "id" ? "✓" : "ID"}
      </button>
      <SessionTime s={s} />
    </div>
  );
}

