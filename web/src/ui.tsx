import { useState } from "react";
import type { Priority, Session } from "@harness/shared";
import { Plus } from "@phosphor-icons/react";

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

