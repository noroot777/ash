import type { Priority } from "@harness/shared";
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
