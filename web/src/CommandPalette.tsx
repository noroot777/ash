import { useEffect, useMemo, useRef, useState } from "react";
import { useEscape } from "./useEscape";

export type Command = {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  run: () => void;
};

export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEscape(onClose, open);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return commands;
    return commands.filter((c) => (c.label + " " + (c.hint ?? "") + " " + (c.group ?? "")).toLowerCase().includes(s));
  }, [q, commands]);

  useEffect(() => {
    if (active >= filtered.length) setActive(0);
  }, [filtered.length, active]);

  if (!open) return null;

  const run = (c: Command | undefined) => {
    if (!c) return;
    c.run();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]" onClick={onClose}>
      <div
        className="w-[560px] max-w-[92vw] overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="输入命令…"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm outline-none placeholder:text-faint"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(filtered[active]);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.map((c, i) => (
            <button
              key={c.id}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(c)}
              className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm ${
                i === active ? "bg-overlay" : ""
              }`}
            >
              <span className="text-ink">{c.label}</span>
              {c.group && <span className="text-[10px] text-faint">{c.group}</span>}
              {c.hint && <span className="ml-auto text-xs text-muted">{c.hint}</span>}
            </button>
          ))}
          {!filtered.length && <p className="px-4 py-6 text-center text-xs text-faint">无匹配命令</p>}
        </div>
      </div>
    </div>
  );
}
