import { useEffect, useState } from "react";
import type { Schedule } from "@harness/shared";
import { CaretDown } from "@phosphor-icons/react";
import { api } from "./api";
import { Menu } from "./Menu";
import { ScheduleFields, toLocalInput } from "./ScheduleFields";

// Compact schedule widget (DESIGN.md §9): none / one-shot / cron, attached to a task.
export function ScheduleControl({ taskId }: { taskId: string }) {
  const [sched, setSched] = useState<Schedule | null>(null);
  const [kind, setKind] = useState<"none" | "once" | "cron">("none");
  const [at, setAt] = useState("");
  const [cron, setCron] = useState("0 9 * * *");

  useEffect(() => {
    api.schedule(taskId).then((s) => {
      setSched(s);
      if (s) {
        setKind(s.kind);
        if (s.at) setAt(toLocalInput(s.at));
        if (s.cron) setCron(s.cron);
      } else {
        setKind("none");
      }
    });
  }, [taskId]);

  const save = async () => {
    if (kind === "none") {
      await api.clearSchedule(taskId);
      setSched(null);
      return;
    }
    const s = await api.setSchedule(taskId, {
      kind,
      at: kind === "once" ? new Date(at).toISOString() : null,
      cron: kind === "cron" ? cron.trim() : null,
    });
    setSched(s);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-faint">定时</span>
      <Menu
        value={kind}
        onChange={(v) => setKind(v as typeof kind)}
        options={[
          { value: "none", label: "不定时" },
          { value: "once", label: "一次性" },
          { value: "cron", label: "循环 (cron)" },
        ]}
        triggerClassName="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-ink hover:bg-raised"
      >
        <span>{kind === "none" ? "不定时" : kind === "once" ? "一次性" : "循环 (cron)"}</span>
        <CaretDown size={11} weight="bold" className="text-faint" />
      </Menu>
      {kind !== "none" && <ScheduleFields kind={kind} at={at} cron={cron} onAt={setAt} onCron={setCron} />}
      {(kind !== "none" || sched) && (
        <button onClick={save} className="rounded-md bg-overlay px-2 py-1 text-ink hover:bg-overlay">
          {kind === "none" ? "清除定时" : "保存"}
        </button>
      )}
      {sched && (
        <span className="text-faint">
          {sched.kind === "once" ? `将于 ${new Date(sched.at!).toLocaleString()} 运行` : `cron ${sched.cron}`}
          {sched.enabled ? "" : " · 已停用"}
          {sched.lastRunAt ? ` · 上次 ${new Date(sched.lastRunAt).toLocaleTimeString()}` : ""}
        </span>
      )}
    </div>
  );
}
