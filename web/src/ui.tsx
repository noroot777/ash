import { useState } from "react";
import type { Priority, Session } from "@harness/shared";
import { PRIORITY_META } from "./constants";

// Linear-style priority bars.
export function PriorityIcon({ p }: { p: Priority }) {
  const meta = PRIORITY_META[p];
  if (p === "none")
    return <span className="inline-block h-3 w-3 text-neutral-700" title="无优先级">·</span>;
  return (
    <span className={`inline-flex items-end gap-[1.5px] ${meta.color}`} title={meta.label}>
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className="w-[2.5px] rounded-[1px] bg-current"
          style={{ height: `${3 + i * 2.5}px`, opacity: meta.bars >= i + 1 || meta.bars === i ? 1 : 0.25 }}
        />
      ))}
    </span>
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
    <div className="flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900/40 px-2 py-1 text-xs">
      <span className="text-neutral-400">{ROLE_LABEL[s.role] ?? s.role}</span>
      <span className="text-neutral-600">·</span>
      <span className="text-neutral-500">{s.executor}</span>
      <button
        onClick={() => copy("cmd", s.resumeCommand ?? "")}
        className="ml-1 rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-700"
        title={s.resumeCommand ?? ""}
      >
        {copied === "cmd" ? "已复制" : "复制 resume 命令"}
      </button>
      <button
        onClick={() => copy("id", s.cliSessionId ?? "")}
        className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-700"
        title={s.cliSessionId ?? ""}
      >
        {copied === "id" ? "✓" : "ID"}
      </button>
    </div>
  );
}

