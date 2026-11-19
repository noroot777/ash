import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ScheduledMessage, TaskListItem } from "@navi/shared";
import { CaretDown, CaretRight, Pulse } from "@phosphor-icons/react";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { monitorIdFromOrigin } from "@navi/shared/monitor";
import { monitorsBrief } from "../monitors/monitorTray.ts";
import { MonitorTrayRow, type TrayMonitors } from "./MonitorTrayRow.tsx";
import { ScheduledMessageRow, scheduledMessageLabel, SteerButton, WithdrawButton } from "./ScheduledMessageRow.tsx";
import { bySendTime, scheduledMessageNeedsAttention, scheduledMessageSource, scheduledMessageText } from "./scheduledMessagePresentation.ts";

type TrayProps = {
  messages: ScheduledMessage[];
  loading: boolean;
  error: string | null;
  cancelingIds: ReadonlySet<string>;
  steeringIds?: ReadonlySet<string>;
  /** 团队回复框不给:调度台那一侧没有引导。 */
  onSteer?: (messageId: string) => void;
  onWithdraw: (message: ScheduledMessage) => void;
  onCancel?: (messageId: string) => void;
  /** 「等某任务完成后发送」那一行要报出在等谁、还等不等得到;没给就只说「等前置任务」。 */
  tasks?: TaskListItem[];
  /** 前置任务不会再完成时(失败/取消/删除/归档),那一行给的出口:不等了,直接发。 */
  onSendNow?: (messageId: string) => void;
  /** 「某某名下已全部停下」那一格点过去打开那一条;没给就只是一句话。 */
  onOpenTask?: (taskId: string) => void;
  /** 还在盯的哨兵:跟排队消息住在同一块里,排在前面。团队回复框不给。 */
  monitors?: TrayMonitors;
  /** 一开始就点开(回归脚本静态渲染点开后的那几行用)。 */
  defaultExpanded?: boolean;
};

/**
 * 回复框上方那一行「排队 N · 哨兵 M」:之后会进这条会话的东西都在这一块——排着的消息,和还在盯、
 * 有事件就会送进来的哨兵(用户 2026-11-16:哨兵另占一行显得臃肿,并进来)。点开是几行:哨兵在前
 * (它们此刻在跑),排队消息按发送顺序在后。收着的时候这一行上带着用户自己最早那条和它的两颗键
 * (撤回、能引导时的「引导会话」);没有自己的消息时带哨兵那一句(盯什么、盯了多久)。
 */
export function ScheduledMessageTray(props: TrayProps) {
  const { messages, loading, error, cancelingIds, steeringIds, onSteer, onWithdraw, onCancel, tasks, onSendNow, onOpenTask, monitors } = props;
  const [expanded, setExpanded] = useState(!!props.defaultExpanded);
  const [pendingCancel, setPendingCancel] = useState<string | null>(null);
  // 点开后要滚到哪一条;focus=true 时连焦点一起交给它那一行的摘要。
  const [reveal, setReveal] = useState<{ id: string; focus: boolean } | null>(null);
  // 全文摊开着的那几条。新输入进来、别的离队都不动它们。
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const bodyIdPrefix = useId();
  const ordered = bySendTime(messages);
  const attention = ordered.filter(scheduledMessageNeedsAttention);
  // 收着那一行带的「自己最早那条」:排在这一轮后面、下一个就发的那条(服务端判引导找的也是它,
  // server/src/task-steer-gate.ts);定时 / 等前置任务的不按这个顺序发,没有排队的才轮到它们。
  const mine = ordered.filter((message) => scheduledMessageSource(message) === "mine");
  const head = mine.find((message) => message.mode === "queued") ?? mine[0];
  const watching = monitors?.live ?? [];
  const waking = watching.some((monitor) => monitor.kind === "ash");
  const now = useMinuteClock(watching.length > 0);
  const hasItems = ordered.length > 0 || watching.length > 0;
  // 哨兵送来的结果前面那个「已结束」：只认读到的终态（TrayMonitors.ended），不拿「不在在盯那几个里」顶。
  const endedOf = (message: ScheduledMessage) => {
    const id = monitorIdFromOrigin(message.origin);
    return !!id && !!monitors?.ended.has(id);
  };
  const open = hasItems && expanded;
  const cancelMessage = ordered.find((message) => message.id === pendingCancel);

  useEffect(() => {
    if (!hasItems) setExpanded(false);
    if (!cancelMessage) setPendingCancel(null);
  }, [hasItems, cancelMessage]);

  useEffect(() => {
    setOpenIds((current) => {
      const next = new Set([...current].filter((key) => messages.some((message) => message.id === key)
        || (monitors?.live ?? []).some((monitor) => `monitor:${monitor.id}` === key)));
      return next.size === current.size ? current : next;
    });
  }, [messages, monitors?.live]);

  useLayoutEffect(() => {
    if (!open || !reveal || !listRef.current) return;
    const list = listRef.current;
    // 每一条是 display: contents,自己没有方框;量它那一行的摘要。
    const summary = [...list.querySelectorAll<HTMLElement>("[data-message-id]")].find((element) => element.dataset.messageId === reveal.id)
      ?.querySelector<HTMLButtonElement>(".scheduled-message-summary");
    if (summary) {
      list.scrollTop += summary.getBoundingClientRect().top - list.getBoundingClientRect().top;
      if (reveal.focus) summary.focus({ preventScroll: true });
    }
    setReveal(null);
  }, [open, reveal]);

  if (!loading && !error && !hasItems) return null;
  const collapse = () => {
    setExpanded(false);
    toggleRef.current?.focus({ preventScroll: true });
  };
  const show = (messageId: string, options: { readable: boolean }) => {
    if (options.readable) setOpenIds((current) => new Set(current).add(messageId));
    setExpanded(true);
    setReveal({ id: messageId, focus: true });
  };
  const toggleBody = (messageId: string) => setOpenIds((current) => {
    const next = new Set(current);
    if (next.has(messageId)) next.delete(messageId); else next.add(messageId);
    return next;
  });
  const busy = (message: ScheduledMessage) => cancelingIds.has(message.id) || !!steeringIds?.has(message.id);

  return <>
    <div className={`scheduled-message-tray${open ? " is-expanded" : ""}`} aria-label="待发送消息" onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        collapse();
      }
    }}>
      {loading && !hasItems && <small>正在加载待发送消息…</small>}
      {error && <p role="alert">待发送消息：{error}</p>}
      {hasItems && <div className="scheduled-tray-line">
        <button ref={toggleRef} type="button" className="scheduled-tray-toggle" aria-expanded={open} aria-controls={listId}
          aria-label={[ordered.length > 0 && `排队 ${ordered.length}`, watching.length > 0 && `哨兵 ${watching.length}`].filter(Boolean).join("，")}
          onClick={() => { if (open) collapse(); else setExpanded(true); }}>
          {open ? <CaretDown size={11} weight="bold" aria-hidden="true" /> : <CaretRight size={11} weight="bold" aria-hidden="true" />}
          {ordered.length > 0 && <span>排队 {ordered.length}</span>}
          {ordered.length > 0 && watching.length > 0 && <span className="scheduled-tray-sep" aria-hidden="true">·</span>}
          {watching.length > 0 && <span className={`scheduled-tray-monitors${waking ? " is-live" : ""}`}>
            <Pulse size={12} aria-hidden="true" /><span className="scheduled-tray-monitors-word">哨兵 </span>{watching.length}
          </span>}
        </button>
        {attention.length > 0 && <button type="button" className="scheduled-tray-attention" aria-label={`查看 ${attention.length} 条退出码非零的输入`}
          onClick={() => show(attention[0]!.id, { readable: false })}>{attention.length} 条要留意</button>}
        {!open && head && <>
          <span className="scheduled-tray-head">
            <span className="scheduled-message-source">你</span>
            <button type="button" className="scheduled-tray-head-summary" aria-label={`查看完整输入：${scheduledMessageLabel(head)}`}
              onClick={() => show(head.id, { readable: true })}>{scheduledMessageLabel(head)}</button>
          </span>
          <WithdrawButton className="is-shown" message={head} tasks={tasks} busy={busy(head)}
            spinning={busy(head) && !steeringIds?.has(head.id)} onWithdraw={onWithdraw} />
          {head.steerable === true && onSteer && <SteerButton message={head} busy={busy(head)} steering={!!steeringIds?.has(head.id)} onSteer={onSteer} />}
        </>}
        {!open && !head && watching.length > 0 && <span className="scheduled-tray-head">
          <button type="button" className="scheduled-tray-head-summary" onClick={() => setExpanded(true)}>
            {monitorsBrief(watching, !!monitors?.running, now)}
          </button>
        </span>}
      </div>}
      {open && <div ref={listRef} id={listId} className="scheduled-tray-list" role="region" aria-label="排队输入完整列表" tabIndex={0}>
        {monitors && watching.map((monitor) => <MonitorTrayRow key={monitor.id} monitor={monitor} monitors={monitors} now={now}
          open={openIds.has(`monitor:${monitor.id}`)} bodyId={`${bodyIdPrefix}-monitor-${monitor.id}`}
          onToggle={() => toggleBody(`monitor:${monitor.id}`)} />)}
        {ordered.map((message) => <ScheduledMessageRow key={message.id} message={message} busy={busy(message)}
          monitorEnded={endedOf(message)}
          steering={!!steeringIds?.has(message.id)} open={openIds.has(message.id)} bodyId={`${bodyIdPrefix}-${message.id}`}
          tasks={tasks} onToggle={() => toggleBody(message.id)} onSteer={onSteer} onWithdraw={onWithdraw}
          onCancel={onCancel ? setPendingCancel : undefined} onSendNow={onSendNow} onOpenTask={onOpenTask} />)}
      </div>}
      <span className="scheduled-message-announcement" role="status">{ordered.length} 条待发送消息{attention.length > 0 && `，${attention.length} 条需留意`}{watching.length > 0 && `，${watching.length} 个哨兵在盯`}</span>
    </div>
    {cancelMessage && onCancel && <ConfirmDialog title="取消这次唤醒？" message="仅移除这条待发送输入，不执行停止哨兵操作。"
      confirmLabel="取消这次唤醒" cancelLabel="保留输入" busy={cancelingIds.has(cancelMessage.id)} danger
      onConfirm={() => onCancel(cancelMessage.id)} onClose={() => setPendingCancel(null)}>
      <p className="scheduled-message-cancel-text">{scheduledMessageText(cancelMessage)}</p>
      {error && <p role="alert">{error}</p>}
    </ConfirmDialog>}
  </>;
}

/** 「盯了几分钟」那几格的钟:只到分钟,半分钟走一次;没有哨兵在盯就不走。 */
function useMinuteClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}
