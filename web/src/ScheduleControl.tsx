import { useEffect, useState } from "react";
import type { Schedule } from "@harness/shared";
import { api } from "./api";

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
      <span className="text-neutral-600">定时</span>
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value as typeof kind)}
        className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-300 outline-none"
      >
        <option value="none">不定时</option>
        <option value="once">一次性</option>
        <option value="cron">循环 (cron)</option>
      </select>
      {kind === "once" && (
        <input
          type="datetime-local"
          value={at}
          onChange={(e) => setAt(e.target.value)}
          className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-300 outline-none [color-scheme:dark]"
        />
      )}
      {kind === "cron" && (
        <input
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          placeholder="分 时 日 月 周"
          className="w-32 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 font-mono text-neutral-300 outline-none"
          title="5 字段 cron（本地时间）。例：0 9 * * 1-5 工作日 9 点"
        />
      )}
      <button onClick={save} className="rounded-md bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700">
        {kind === "none" ? "清除" : "保存"}
      </button>
      {sched && (
        <span className="text-neutral-600">
          {sched.kind === "once" ? `将于 ${new Date(sched.at!).toLocaleString()} 运行` : `cron ${sched.cron}`}
          {sched.enabled ? "" : " · 已停用"}
          {sched.lastRunAt ? ` · 上次 ${new Date(sched.lastRunAt).toLocaleTimeString()}` : ""}
        </span>
      )}
    </div>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
