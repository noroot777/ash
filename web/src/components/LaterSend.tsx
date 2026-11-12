// 回复框的发送按钮:主按钮 + 连体的「发送设置」段,跟新建面板的「创建并运行 ▸ 启动设置」
// 是同一套(composer/ComposerLaunchControl.tsx):发送方式是回复框的一项设置,选了什么主
// 按钮就按什么发,文案和右段图标跟着变;回到「立即发送」就是撤掉这项设置。
// 三档对应服务端待发送消息的 立即 / timed / after(shared/src/schedule.ts)。
// 普通任务回复框与团队调度台回复框共用这一份,两边长得不一样会被当成 bug 报上来。
import { useEffect, useState } from "react";
import type { Group, ScheduledMessage, TaskListItem } from "@ash/shared";
import { ArrowUp, Clock, HourglassMedium, PaperPlaneRight, SpinnerGap, Stop } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import type { DraftHandle } from "../lib/DraftStore.tsx";
import { sendAfterOptions } from "../lib/sendAfter.ts";
import { useRovingChoice } from "../lib/useRovingChoice.ts";
import { ComposerPopover } from "../composer/ComposerPopover.tsx";
import { Dropdown } from "./Dropdown.tsx";
import { defaultOnceTime, toLocalDateTime } from "./ScheduleControl.tsx";

export type LaterKind = "now" | "timed" | "after";
/** 交给 /reply 的那一份:二选一,哪个都不带就是立即发送。 */
export type LaterChoice = { sendAt?: string; afterTaskId?: string };

const KINDS: { value: LaterKind; label: string; submit: string }[] = [
  { value: "now", label: "立即发送", submit: "发送" },
  { value: "timed", label: "指定时间", submit: "定时发送" },
  { value: "after", label: "等任务完成", submit: "完成后发送" },
];
const KIND_VALUES = KINDS.map((kind) => kind.value);

function KindIcon({ kind }: { kind: LaterKind }) {
  if (kind === "timed") return <Clock size={12} />;
  if (kind === "after") return <HourglassMedium size={12} />;
  return <PaperPlaneRight size={12} />;
}

/** 发送方式的读写。状态本身存在这份回复草稿里(DraftStore 的 later 字段),跟正文一起
 *  跨切任务保留、一起清掉;这里只负责解释它。 */
export function useLaterSend(draft: Pick<DraftHandle, "later" | "setLater">) {
  const { later, setLater } = draft;
  const kind: LaterKind = later?.kind ?? "now";
  const at = later?.at ?? "";
  const afterTaskId = later?.afterTaskId ?? "";
  const time = new Date(at).getTime();
  /** null = 选了「稍后」但还没配好(没选任务 / 时间不晚于现在):这时不能发,也绝不退回立即发。
   *  每次调用都按此刻的时钟判:提交时要重判,不能拿渲染那一刻算好的结果。 */
  const resolve = (): LaterChoice | null => kind === "now"
    ? {}
    : kind === "timed"
      ? Number.isFinite(time) && time > Date.now() ? { sendAt: new Date(time).toISOString() } : null
      : afterTaskId ? { afterTaskId } : null;
  // 选定的时刻一过,按钮得自己变灰,不等下一次输入才重渲染。
  const [, expire] = useState(0);
  useEffect(() => {
    if (kind !== "timed" || !Number.isFinite(time) || time <= Date.now()) return;
    const timer = window.setTimeout(() => expire((count) => count + 1), Math.min(time - Date.now() + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [kind, time]);
  const choice = resolve();
  const blockerOf = (current: LaterChoice | null) =>
    current ? null : kind === "timed" ? "发送时间得晚于现在" : "还没选要等哪个任务";

  return {
    kind, at, afterTaskId, choice, resolve, blockerOf,
    blocker: blockerOf(choice),
    submitLabel: KINDS.find((item) => item.value === kind)!.submit,
    setAt: (value: string) => setLater((current) => ({ kind: "timed", at: value, afterTaskId: current?.afterTaskId ?? "" })),
    setAfterTaskId: (value: string) => setLater((current) => ({ kind: "after", at: current?.at ?? "", afterTaskId: value })),
    reset: () => setLater(null),
    setKind: (next: LaterKind) => {
      if (next === "now") return setLater(null);
      setLater((current) => ({
        kind: next,
        at: current?.at || (next === "timed" ? defaultOnceTime() : ""),
        afterTaskId: current?.afterTaskId ?? "",
      }));
    },
    /** 撤回一条消息时把它当初的「稍后」也放回来:定时的还没到点才留,等任务的原样留。 */
    restore: (message: ScheduledMessage) => {
      if (message.mode === "after" && message.afterTaskId) {
        setLater({ kind: "after", at: "", afterTaskId: message.afterTaskId });
      } else if (message.mode === "timed" && new Date(message.sendAt).getTime() > Date.now()) {
        setLater({ kind: "timed", at: toLocalDateTime(new Date(message.sendAt)), afterTaskId: "" });
      }
    },
  };
}

export type LaterSend = ReturnType<typeof useLaterSend>;

/** 分体发送按钮。label 是「立即发送」这一档的文案(排队发送 / 发送…);选了「稍后」就换成那一档
 *  的文案,免得设置藏在浮层里、按钮看上去还是「发送」。status 是此刻主按钮不在「发送」的
 *  那些情形(上传中、补全技能…),它优先,也不受「稍后」没配好的拦截。 */
/**
 * 任务在跑时这颗键也是停止键（docs/ui-ux-audit reply-4）：输入框空着时主段就是停止；打了字
 * 主段要用来排队发送，停止挪到它左边一颗小键上——什么时候都停得下来。
 */
export type SendStop = { label: string; busy?: boolean; onStop: () => void };

export function SendSplit({ later, label, status, ariaLabel, sending, disabled,
  configDisabled, onSend, tasks, projectId, taskId, stop, empty }: {
  later: LaterSend;
  label: string;
  status?: string | null;
  ariaLabel: string;
  sending: boolean;
  disabled: boolean;
  configDisabled: boolean;
  onSend: () => void;
  tasks: TaskListItem[];
  projectId: string;
  taskId: string;
  /** 给了 = 任务正在跑 / 排着队，这颗键也管停。 */
  stop?: SendStop | null;
  /** 输入框里一个字、一个附件都没有（停止键占主段的判据之一）。 */
  empty?: boolean;
}) {
  const configured = later.kind !== "now";
  const text = status ?? (configured ? later.submitLabel : label);
  const stopAsMain = !!stop && !!empty && !status && !sending;
  return (
    <span className="send-split">
      {stop && !stopAsMain && (
        <button type="button" className="send-split-halt" aria-label={stop.label} disabled={stop.busy} onClick={stop.onStop}>
          {stop.busy ? <SpinnerGap size={12} className="is-spinning" aria-hidden="true" /> : <Stop size={12} weight="fill" aria-hidden="true" />}
        </button>
      )}
      {stopAsMain ? (
        <button type="button" className="send-split-main is-stop" aria-label={stop.label} disabled={stop.busy} onClick={stop.onStop}>
          {stop.busy ? <SpinnerGap size={14} className="is-spinning" aria-hidden="true" /> : <Stop size={14} weight="fill" aria-hidden="true" />}
        </button>
      ) : (
        <button type="button" className="send-split-main" disabled={disabled || (!status && !later.choice)}
          aria-label={configured && !status ? text : ariaLabel} onClick={onSend}>
          <span>{text}</span>{sending ? <SpinnerGap size={14} className="is-spinning" /> : <ArrowUp size={14} weight="bold" />}
        </button>
      )}
      <ComposerPopover label="发送设置" value={KINDS.find((item) => item.value === later.kind)!.label}
        disabled={configDisabled} className={`studio-submit-mode${configured ? " is-configured" : ""}`}
        trigger={<KindIcon kind={later.kind} />}>
        <LaterSendFields later={later} tasks={tasks} projectId={projectId} taskId={taskId} />
      </ComposerPopover>
    </span>
  );
}

function LaterSendFields({ later, tasks, projectId, taskId }: {
  later: LaterSend;
  tasks: TaskListItem[];
  projectId: string;
  taskId: string;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const kindGroup = useRovingChoice(KIND_VALUES, later.kind, later.setKind);
  // 分组名只用来给候选分段,拿不到就不分段,不挡选择。
  useEffect(() => {
    let alive = true;
    api.groups(projectId).then((rows) => { if (alive) setGroups(rows); }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId]);

  const target = tasks.find((task) => task.id === later.afterTaskId);
  return <>
    <div className="composer-launch-mode" {...kindGroup.groupProps} aria-label="发送方式">
      <span>发送方式</span>
      <div className="composer-launch-mode-grid">
        {KINDS.map((kind) => (
          <button key={kind.value} type="button" {...kindGroup.itemProps(kind.value)}
            className={`composer-launch-mode-chip${later.kind === kind.value ? " is-active" : ""}`}
            onClick={() => later.setKind(kind.value)}>
            <KindIcon kind={kind.value} />{kind.label}
          </button>
        ))}
      </div>
    </div>
    {later.kind === "timed" && (
      <label className="schedule-field schedule-field--once">
        <Clock size={13} aria-hidden="true" />
        <input type="datetime-local" aria-label="发送时间" value={later.at}
          min={toLocalDateTime(new Date(Date.now() + 60_000))}
          onChange={(event) => later.setAt(event.target.value)} />
      </label>
    )}
    {later.kind === "after" && (
      <div className="composer-field composer-queue-after">
        <Dropdown label="等哪个任务完成" value={later.afterTaskId}
          placeholder="选择任务…" filterPlaceholder="筛选任务…"
          options={sendAfterOptions({ tasks, groups, projectId, taskId })}
          onChange={later.setAfterTaskId}
          onClear={later.afterTaskId ? () => later.setKind("now") : undefined} clearLabel="不等了，立即发送" />
      </div>
    )}
    {later.kind !== "now" && (
      <p className="studio-help">
        <KindIcon kind={later.kind} />
        {later.kind === "timed" ? later.choice ? "到点自动发出，发出前可在待发送里撤回。" : later.blocker
          : target ? `等「${target.title || "未命名任务"}」完成后自动发出。` : "先选一个要等的任务，它完成后自动发出。"}
      </p>
    )}
  </>;
}
