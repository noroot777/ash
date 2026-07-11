import { useEffect, useState } from "react";
import type { Schedule } from "@harness/shared";
import { CaretDown } from "@phosphor-icons/react";
import { api } from "./api";
import { Menu } from "./Menu";
import { toast } from "./toast";
import { ScheduleFields, toLocalInput } from "./ScheduleFields";

// Compact schedule widget (DESIGN.md §9): none / one-shot / cron, attached to a task.
export function ScheduleControl({ taskId }: { taskId: string }) {
  const [sched, setSched] = useState<Schedule | null>(null);
  const [kind, setKind] = useState<"none" | "once" | "cron">("none");
  const [at, setAt] = useState("");
  const [cron, setCron] = useState("0 9 * * *");
  const [firing, setFiring] = useState(false);

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

  // 仅当编辑值与已存定时不一致时才提示「保存 / 清除」——没改动就不显示按钮。
  const dirty = (() => {
    if (kind === "none") return !!sched;
    if (!sched || sched.kind !== kind) return true;
    if (kind === "once") return at !== (sched.at ? toLocalInput(sched.at) : "");
    return cron.trim() !== (sched.cron ?? "");
  })();

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
      {kind === "cron" && (
        <button
          disabled={firing}
          onClick={async () => {
            // 错过班次手动补跑:等同调度器到点触发——全新一轮,不接续旧会话。
            setFiring(true);
            try {
              await api.fireTask(taskId);
              toast("已触发一轮全新运行(不接续旧会话)", "info");
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e));
            } finally {
              setFiring(false);
            }
          }}
          title="现在就跑一轮全新运行,效果等同定时到点触发(不接续旧会话)"
          className="rounded-md border border-line px-2 py-1 text-ink hover:bg-raised disabled:opacity-50"
        >
          {firing ? "触发中…" : "立即触发"}
        </button>
      )}
      {dirty && (
        <button onClick={save} className="rounded-md bg-overlay px-2 py-1 text-ink hover:bg-overlay">
          {kind === "none" ? "清除定时" : "保存"}
        </button>
      )}
    </div>
  );
}
