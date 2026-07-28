// Shared schedule value editor (§9), used both at creation (TaskComposer) and for
// post-creation editing (ScheduleControl) so the two stay in sync. It edits the
// VALUE for a given kind only — the none/once/cron kind switch and any save/clear
// affordance live in the parent.
//   once → a datetime-local picker + a「将于 X 运行」note.
//   cron → the raw 5-field expression (local time), with an example in the title.
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
  return (
    <input
      value={cron}
      onChange={(e) => onCron(e.target.value)}
      placeholder="分 时 日 月 周"
      className="w-28 rounded-md border border-line bg-panel px-2 py-1 font-mono text-ink outline-none"
      title="5 字段 cron（本地时间）。例：0 9 * * 1-5 工作日 9 点"
    />
  );
}

// ISO → the value a <input type="datetime-local"> expects (local, no seconds/tz).
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
