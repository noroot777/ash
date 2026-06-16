import { useState, useEffect } from "react";
import type { Priority, Session, ProjectHealth } from "@harness/shared";
import { Plus } from "@phosphor-icons/react";
import { shortPath } from "./util";
import { api } from "./api";

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

const ROLE_LABEL: Record<string, string> = {
  single: "single",
  debaterA: "辩手A",
  debaterB: "辩手B",
  implementer: "实现方",
};

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

// Traceability credential chip — copy the ready-to-paste resume command (§13).
export function Credential({ s }: { s: Session }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1200);
  };
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-line bg-raised/50 px-2 py-1 text-xs">
      <span className="text-muted">{ROLE_LABEL[s.role] ?? s.role}</span>
      <span className="text-faint">·</span>
      <span className="text-muted">{s.executor}</span>
      {s.cwd && (
        <>
          <span className="text-faint">·</span>
          <span className="font-mono text-[11px] text-faint" title={s.cwd}>
            {s.cwd.includes("/scratch/") ? "⚠ 临时目录" : shortPath(s.cwd)}
            {s.branch ? ` (${s.branch})` : ""}
          </span>
        </>
      )}
      <button
        onClick={() => copy("cmd", s.resumeCommand ?? "")}
        className="ml-1 rounded bg-overlay px-1.5 py-0.5 text-ink hover:bg-overlay"
        title={s.resumeCommand ?? ""}
      >
        {copied === "cmd" ? "已复制" : "复制 resume 命令"}
      </button>
      <button
        onClick={() => copy("id", s.cliSessionId ?? "")}
        className="rounded bg-overlay px-1.5 py-0.5 text-muted hover:bg-overlay"
        title={s.cliSessionId ?? ""}
      >
        {copied === "id" ? "✓" : "ID"}
      </button>
    </div>
  );
}

