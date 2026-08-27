import { useEffect, useState } from "react";
import { useExecutorGate } from "../task-detail/ExecutorGate.tsx";
import type { Schedule } from "@ash/shared";
import { ArrowsClockwise, Clock, Lightning, SpinnerGap } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { Button } from "./ui.tsx";

export type ScheduleKind = "once" | "cron";
export type ScheduleDraftKind = "none" | ScheduleKind;

export const DEFAULT_CRON = "0 9 * * *";

export function toLocalDateTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function defaultOnceTime(): string {
  return toLocalDateTime(new Date(Date.now() + 60 * 60 * 1000));
}

export function scheduleValidationError(kind: ScheduleKind, at: string, cron: string): string | null {
  if (kind === "once") {
    if (!at) return "请选择一次性运行时间";
    if (!Number.isFinite(new Date(at).getTime())) return "一次性运行时间无效";
    return null;
  }
  if (!cron.trim()) return "请输入 Cron 表达式";
  if (cron.trim().split(/\s+/).length !== 5) return "Cron 需要 5 个字段：分 时 日 月 周";
  return null;
}

export function ScheduleFields({
  kind,
  at,
  cron,
  disabled = false,
  onAtChange,
  onCronChange,
}: {
  kind: ScheduleKind;
  at: string;
  cron: string;
  disabled?: boolean;
  onAtChange: (value: string) => void;
  onCronChange: (value: string) => void;
}) {
  if (kind === "once") {
    return (
      <label className="schedule-field schedule-field--once">
        <Clock size={13} aria-hidden="true" />
        <input
          type="datetime-local"
          value={at}
          disabled={disabled}
          aria-label="一次性运行时间"
          onChange={(event) => onAtChange(event.target.value)}
        />
      </label>
    );
  }
  return (
    <label className="schedule-field schedule-field--cron">
      <ArrowsClockwise size={13} aria-hidden="true" />
      <input
        value={cron}
        disabled={disabled}
        aria-label="Cron 表达式"
        placeholder="分 时 日 月 周"
        onChange={(event) => onCronChange(event.target.value)}
      />
    </label>
  );
}

function scheduleSummary(schedule: Schedule | null): string {
  if (!schedule) return "未设置定时";
  if (!schedule.enabled) return schedule.kind === "once" ? "这次定时已执行；保存可重新启用" : "定时已停用";
  if (schedule.kind === "once") {
    return schedule.at ? `将于 ${new Date(schedule.at).toLocaleString()} 运行一轮` : "一次性定时未填写时间";
  }
  const lastRun = schedule.lastRunAt ? ` · 上次 ${new Date(schedule.lastRunAt).toLocaleString()}` : "";
  return `按本地时间运行 · ${schedule.cron ?? "未配置"}${lastRun}`;
}

export function ScheduleControl({
  taskId,
  notify,
  disabled = false,
  className = "",
}: {
  taskId: string;
  notify: (message: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [kind, setKind] = useState<ScheduleDraftKind>("none");
  const [at, setAt] = useState("");
  const [cron, setCron] = useState(DEFAULT_CRON);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [firing, setFiring] = useState(false);
  const confirmExecutorSwap = useExecutorGate();
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError("");
    api.schedule(taskId).then((value) => {
      if (!alive) return;
      setSchedule(value);
      setKind(value?.kind ?? "none");
      setAt(value?.at ? toLocalDateTime(value.at) : "");
      setCron(value?.cron || DEFAULT_CRON);
    }).catch((reason) => {
      if (!alive) return;
      setSchedule(null);
      setKind("none");
      setLoadError(reason instanceof Error ? reason.message : "调度读取失败");
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [taskId]);

  const dirty = (() => {
    if (loading) return false;
    if (kind === "none") return schedule !== null;
    if (!schedule || schedule.kind !== kind || !schedule.enabled) return true;
    if (kind === "once") return at !== (schedule.at ? toLocalDateTime(schedule.at) : "");
    return cron.trim() !== (schedule.cron ?? "");
  })();

  const changeKind = (next: ScheduleDraftKind) => {
    setKind(next);
    if (next === "once" && !at) setAt(defaultOnceTime());
  };

  const save = async () => {
    if (kind !== "none") {
      const validation = scheduleValidationError(kind, at, cron);
      if (validation) return notify(validation);
    }
    setSaving(true);
    try {
      if (kind === "none") {
        await api.clearSchedule(taskId);
        setSchedule(null);
        notify("定时已清除");
        return;
      }
      const next = await api.setSchedule(taskId, kind === "once"
        ? { kind, at: new Date(at).toISOString(), cron: null }
        : { kind, at: null, cron: cron.trim() });
      setSchedule(next);
      setAt(next.at ? toLocalDateTime(next.at) : at);
      setCron(next.cron || cron);
      notify(kind === "once" ? "一次性定时已保存" : "Cron 定时已保存");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const fire = async () => {
    // fire 是「现在就跑一班新的」—— 一样会起一轮,一样先过换执行器确认闸(§八)。
    if (!(await confirmExecutorSwap(taskId))) return;
    setFiring(true);
    try {
      await api.fireTask(taskId);
      notify("已触发一轮全新运行，不接续旧会话");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setFiring(false);
    }
  };

  const unavailable = disabled || loading || saving || firing;
  return (
    <div className={`schedule-control ${className}`.trim()}>
      <div className="schedule-control-fields">
        <label className="schedule-kind-field">
          <span>启动</span>
          <select
            value={kind}
            disabled={unavailable}
            aria-label="调度类型"
            onChange={(event) => changeKind(event.target.value as ScheduleDraftKind)}
          >
            <option value="none">不定时</option>
            <option value="once">一次性</option>
            <option value="cron">循环 Cron</option>
          </select>
        </label>
        {kind !== "none" && (
          <ScheduleFields
            kind={kind}
            at={at}
            cron={cron}
            disabled={unavailable}
            onAtChange={setAt}
            onCronChange={setCron}
          />
        )}
      </div>
      <div className="schedule-control-footer">
        <small className={loadError ? "is-error" : ""}>
          {loading ? <><SpinnerGap size={11} className="is-spinning" />正在读取调度…</> : loadError || scheduleSummary(schedule)}
        </small>
        {kind === "cron" && (
          <Button variant="ghost" disabled={unavailable} onClick={() => void fire()}>
            <Lightning size={12} weight="fill" />{firing ? "触发中…" : "立即触发"}
          </Button>
        )}
        {dirty && (
          <Button variant="primary" disabled={unavailable} onClick={() => void save()}>
            {saving ? "保存中…" : kind === "none" ? "清除定时" : schedule?.enabled === false ? "重新启用" : "保存"}
          </Button>
        )}
      </div>
      {disabled && <p className="schedule-control-disabled">归档任务或团队执行者不能修改调度。</p>}
    </div>
  );
}
