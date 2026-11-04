// 「稍后发送」:发送按钮旁那颗小三角打开的浮层。两种「稍后」——到某个时刻发、等某个任务
// 完成后发——共用一个入口,对应服务端待发送消息的 timed / after 两档(shared/src/schedule.ts)。
// 普通任务回复框与团队调度台回复框共用这一份,两边长得不一样会被当成 bug 报上来。
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Group, ScheduledMessage, TaskListItem } from "@ash/shared";
import { CaretUp, SpinnerGap } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { sendAfterOptions } from "../lib/sendAfter.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { Dropdown } from "./Dropdown.tsx";
import { defaultOnceTime, toLocalDateTime } from "./ScheduleControl.tsx";

export type LaterKind = "timed" | "after";
/** 交给 /reply 的那一份:二选一,哪个都不带就是立即发送。 */
export type LaterChoice = { sendAt?: string; afterTaskId?: string };

export function useLaterSend() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<LaterKind>("timed");
  const [at, setAt] = useState("");
  const [afterTaskId, setAfterTaskId] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);

  const time = new Date(at).getTime();
  const choice: LaterChoice | null = kind === "timed"
    ? Number.isFinite(time) && time > Date.now() ? { sendAt: new Date(time).toISOString() } : null
    : afterTaskId ? { afterTaskId } : null;

  return {
    open, kind, at, afterTaskId, triggerRef, choice,
    setKind, setAt, setAfterTaskId,
    close: () => setOpen(false),
    toggle: () => {
      if (!at) setAt(defaultOnceTime());
      setOpen((current) => !current);
    },
    reset: () => {
      setOpen(false);
      setKind("timed");
      setAt("");
      setAfterTaskId("");
    },
    /** 撤回一条消息时把它当初的「稍后」也放回来:定时的还没到点才留,等任务的原样留。 */
    restore: (message: ScheduledMessage) => {
      if (message.mode === "after" && message.afterTaskId) {
        setKind("after");
        setAfterTaskId(message.afterTaskId);
      } else if (message.mode === "timed" && new Date(message.sendAt).getTime() > Date.now()) {
        setKind("timed");
        setAt(toLocalDateTime(new Date(message.sendAt)));
      }
    },
  };
}

export type LaterSend = ReturnType<typeof useLaterSend>;

/** 发送按钮 + 小三角,拼成一颗分体按钮。主按钮由调用方给(两个回复框各有各的图标与文案)。 */
export function SendSplit({ later, disabled, children }: { later: LaterSend; disabled: boolean; children: ReactNode }) {
  return (
    <span className="send-split">
      {children}
      <button ref={later.triggerRef} type="button" className="send-split-more" disabled={disabled}
        aria-label="稍后发送" aria-haspopup="dialog" aria-expanded={later.open}
        onClick={later.toggle}>
        <CaretUp size={10} weight="bold" />
      </button>
    </span>
  );
}

export function LaterSendPanel({ later, tasks, projectId, taskId, busy, hasContent, onSubmit }: {
  later: LaterSend;
  tasks: TaskListItem[];
  projectId: string;
  taskId: string;
  busy: boolean;
  hasContent: boolean;
  onSubmit: (choice: LaterChoice) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  useDismissable({ enabled: true, containerRef: panelRef, onClose: later.close, restoreFocusRef: later.triggerRef });
  // 分组名只用来给候选分段,拿不到就不分段,不挡选择。
  useEffect(() => {
    let alive = true;
    api.groups(projectId).then((rows) => { if (alive) setGroups(rows); }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId]);

  const choice = later.choice;
  return (
    <div ref={panelRef} className="scheduled-send-panel" role="dialog" aria-label="稍后发送">
      <div className="later-send-kinds" role="radiogroup" aria-label="什么时候发">
        {([["timed", "指定时间"], ["after", "等任务完成"]] as const).map(([kind, label]) => (
          <button key={kind} type="button" role="radio" aria-checked={later.kind === kind} disabled={busy}
            onClick={() => later.setKind(kind)}>{label}</button>
        ))}
      </div>
      {later.kind === "timed" ? (
        <input
          type="datetime-local"
          aria-label="发送时间"
          value={later.at}
          min={toLocalDateTime(new Date(Date.now() + 60_000))}
          disabled={busy}
          autoFocus
          onChange={(event) => later.setAt(event.target.value)}
        />
      ) : (
        <Dropdown className="later-send-target" label="等哪个任务完成" value={later.afterTaskId}
          placeholder="选择任务…" filterPlaceholder="筛选任务…" disabled={busy}
          options={sendAfterOptions({ tasks, groups, projectId, taskId })}
          onChange={later.setAfterTaskId} />
      )}
      <footer>
        <button type="button" disabled={busy} onClick={later.close}>取消</button>
        <button type="button" disabled={!choice || !hasContent || busy} onClick={() => choice && onSubmit(choice)}>
          {busy && <SpinnerGap size={12} className="is-spinning" />}
          {later.kind === "timed" ? "定时发送" : "完成后发送"}
        </button>
      </footer>
    </div>
  );
}
