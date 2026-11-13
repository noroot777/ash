// 回复框的发送按钮:主按钮 + 连体的「发送设置」段,跟新建面板的「创建并运行 ▸ 启动设置」
// 是同一套(composer/ComposerLaunchControl.tsx):发送方式是回复框的一项设置,选了什么主
// 按钮就按什么发,文案和右段图标跟着变;回到「立即发送」就是撤掉这项设置。
// 三档对应服务端待发送消息的 立即 / timed / after(shared/src/schedule.ts)。
// 普通任务回复框与团队调度台回复框共用这一份,两边长得不一样会被当成 bug 报上来。
import { useEffect, useState } from "react";
import type { Group, ScheduledMessage, TaskListItem } from "@ash/shared";
import { Clock } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { localeDateTime } from "../lib/localeFormat.ts";
import type { DraftHandle } from "../lib/DraftStore.tsx";
import { sendAfterOptions } from "../lib/sendAfter.ts";
import { useRovingChoice } from "../lib/useRovingChoice.ts";
import { Dropdown } from "./Dropdown.tsx";
import { defaultOnceTime, toLocalDateTime } from "./ScheduleControl.tsx";
import { SendKey, type SendKeyStop } from "./SendKey.tsx";

export type LaterKind = "now" | "timed" | "after";
/** 交给 /reply 的那一份:二选一,哪个都不带就是立即发送。 */
export type LaterChoice = { sendAt?: string; afterTaskId?: string };

const KINDS: { value: LaterKind; label: string; submit: string }[] = [
  { value: "now", label: "立即发送", submit: "发送" },
  { value: "timed", label: "指定时间", submit: "定时发送" },
  { value: "after", label: "等任务完成", submit: "完成后发送" },
];
const KIND_VALUES = KINDS.map((kind) => kind.value);

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

/**
 * 回复框用的发送键：共用发送键（SendKey.tsx）+ 尖角里的「发送设置」三档。调用方只给事实
 * （空没空、任务在不在跑、在不在传附件、还有什么别的原因发不出去），这里翻成那颗键的长相：
 *  · 任务在跑、输入框空着、给了 onStop：主段就是停止键；
 *  · 任务在跑、打了字：键上写「排队发送」，左边多一颗小停止键；
 *  · 选了「稍后」：键上写「定时发送 / 完成后发送」，尖角换时钟 / 沙漏；没配好时键淡、提示说缺什么；
 *  · 传附件：键上写进度，键淡；
 *  · `override` 给斜杠命令那类「这一下不是发送」的情形（补全、打开派生配置），它优先，也不受「稍后」拦。
 * 回车照旧走调用方自己的 send()，那里面要按 later.resolve() 再判一次。
 */
export function LaterSendKey({ later, action = "发送", empty, running = false, uploading, blocked, busy = false,
  override, onSend, onStop, stopTip = "停止这一轮", stopBusy = false, configDisabled = false, tasks, projectId, taskId, size = "sm" }: {
  later: LaterSend;
  /** 立即那一档做的事，进读屏名和提示（「发送」「发送给调度者」）。 */
  action?: string;
  empty: boolean;
  running?: boolean;
  /** 正在传附件时键上的字（uploadingLabel 的结果）。 */
  uploading?: string | null;
  /** 别的发不出去的原因（只读、归档、正在派生…）。 */
  blocked?: string | null;
  busy?: boolean;
  override?: { text: string; action: string } | null;
  onSend: () => void;
  onStop?: () => void;
  stopTip?: string;
  /** 停止请求还在路上：停止键点不动，免得连按出两次。 */
  stopBusy?: boolean;
  configDisabled?: boolean;
  tasks: TaskListItem[];
  projectId: string;
  taskId: string;
  size?: "sm" | "md";
}) {
  const configured = later.kind !== "now";
  const target = tasks.find((task) => task.id === later.afterTaskId);
  const stop: SendKeyStop | null = onStop ? { tip: stopTip, onStop, disabled: stopBusy } : null;
  const stopping = running && empty && !uploading && !override && !!stop;
  const time = later.kind === "timed" && later.choice ? new Date(later.at) : null;
  const text = uploading ?? override?.text ?? (configured ? later.submitLabel : running ? "排队发送" : "");
  const reason = uploading ? "附件传完才能发"
    : override ? blocked ?? null
      : empty ? "先写点内容"
        : blocked ?? (configured ? later.blocker : null);
  const tip = override ? override.action
    : later.kind === "timed" && time ? `${localeDateTime(time, "zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 自动发出`
      : later.kind === "after" && target ? `等「${target.title || "未命名任务"}」完成后发出`
        : running ? "排队，这一轮结束后发出" : null;
  return (
    <SendKey
      size={size}
      action={override?.action ?? action}
      text={text}
      tip={tip}
      blocked={reason}
      busy={busy}
      stop={stopping ? stop : null}
      halt={running && !stopping && stop ? stop : null}
      onSend={onSend}
      settings={{
        label: "发送设置",
        value: KINDS.find((item) => item.value === later.kind)!.label,
        glyph: uploading ? "sand" : later.kind === "timed" ? "clock" : later.kind === "after" ? "sand" : "caret",
        disabled: configDisabled,
        children: <LaterSendSettings later={later} tasks={tasks} projectId={projectId} taskId={taskId} />,
      }}
    />
  );
}

/** 「发送设置」那一层：三档分段，下面是这一档要填的那一样。选了不收起，Esc / 点外面 / 再点尖角才收。 */
export function LaterSendSettings({ later, tasks, projectId, taskId }: {
  later: LaterSend;
  tasks: TaskListItem[];
  projectId: string;
  taskId: string;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const kindGroup = useRovingChoice(KIND_VALUES, later.kind, later.setKind);
  useEffect(() => {
    let alive = true;
    api.groups(projectId).then((rows) => { if (alive) setGroups(rows); }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId]);
  const target = tasks.find((task) => task.id === later.afterTaskId);
  return <>
    <div className="send-key-seg" {...kindGroup.groupProps} aria-label="发送方式">
      {KINDS.map((kind) => (
        <button key={kind.value} type="button" {...kindGroup.itemProps(kind.value)} onClick={() => later.setKind(kind.value)}>{kind.label}</button>
      ))}
    </div>
    {later.kind !== "now" && <div className="send-key-body">
      {later.kind === "timed" && (
        <label className="schedule-field schedule-field--once">
          <Clock size={13} aria-hidden="true" />
          <input type="datetime-local" aria-label="发送时间" value={later.at}
            min={toLocalDateTime(new Date(Date.now() + 60_000))}
            onChange={(event) => later.setAt(event.target.value)} />
        </label>
      )}
      {later.kind === "after" && (
        <div className="composer-queue-after">
          <Dropdown label="等哪个任务完成" value={later.afterTaskId}
            placeholder="选择任务…" filterPlaceholder="筛选任务…"
            options={sendAfterOptions({ tasks, groups, projectId, taskId })}
            onChange={later.setAfterTaskId}
            onClear={later.afterTaskId ? () => later.setKind("now") : undefined} clearLabel="不等了，立即发送" />
        </div>
      )}
      <p>{later.kind === "timed" ? later.choice ? "到点自动发出，发出前可在待发送里撤回。" : later.blocker
        : target ? `等「${target.title || "未命名任务"}」完成后自动发出。` : "先选一个要等的任务，它完成后自动发出。"}</p>
    </div>}
  </>;
}
