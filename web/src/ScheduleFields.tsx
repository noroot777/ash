import { useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { CRON_PRESETS, describeCron } from "./constants";
import { Menu } from "./Menu";

// Shared schedule value editor (§9), used both at creation (CreateTask) and for
// post-creation editing (ScheduleControl) so the two stay in sync. It edits the
// VALUE for a given kind only — the none/once/cron kind switch and any save/clear
// affordance live in the parent.
//   once → a datetime-local picker + a「将于 X 运行」note.
//   cron → a friendly preset menu (CRON_PRESETS) with a「自定义」escape hatch that
//          reveals the raw 5-field input; a describeCron note alongside.
export function ScheduleFields({
  kind,
  at,
  cron,
  onAt,
  onCron,
}: {
  kind: "once" | "cron";
  at: string;
  cron: string;
  onAt: (v: string) => void;
  onCron: (v: string) => void;
}) {
  // Whether the raw cron input is shown. Seeded from the value (an expr that
  // matches no preset starts in custom mode); toggled explicitly so picking
  // 「自定义」reveals the field even when the current expr happens to match one.
  const [showCustom, setShowCustom] = useState(() => !CRON_PRESETS.some((p) => p.cron === cron.trim()));

  if (kind === "once") {
    return (
      <>
        <input
          type="datetime-local"
          value={at}
          onChange={(e) => onAt(e.target.value)}
          className="rounded-md border border-line bg-panel px-2 py-1 text-ink outline-none"
        />
        {at && <span className="text-faint">将于 {new Date(at).toLocaleString()} 运行</span>}
      </>
    );
  }

  const matched = CRON_PRESETS.find((p) => p.cron === cron.trim());
  return (
    <>
      <Menu
        value={showCustom ? "__custom" : matched?.cron ?? "__custom"}
        onChange={(v) => {
          if (v === "__custom") setShowCustom(true);
          else {
            setShowCustom(false);
            onCron(v);
          }
        }}
        options={[...CRON_PRESETS.map((p) => ({ value: p.cron, label: p.label })), { value: "__custom", label: "自定义…" }]}
        triggerClassName="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-ink hover:bg-raised"
      >
        <span>{showCustom ? "自定义" : matched?.label ?? "自定义"}</span>
        <CaretDown size={11} weight="bold" className="text-faint" />
      </Menu>
      {showCustom && (
        <input
          value={cron}
          onChange={(e) => onCron(e.target.value)}
          placeholder="分 时 日 月 周"
          className="w-32 rounded-md border border-line bg-panel px-2 py-1 font-mono text-ink outline-none"
          title="5 字段 cron（本地时间）。例：0 9 * * 1-5 工作日 9 点"
        />
      )}
      {cron.trim() && <span className="text-faint">{describeCron(cron)}</span>}
    </>
  );
}

// ISO → the value a <input type="datetime-local"> expects (local, no seconds/tz).
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
