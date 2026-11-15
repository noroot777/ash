// 派活单：智能体想派出一批任务时先摆给你看（服务端见 server/src/dispatch-plan*.ts），它占住回复框那一格，
// 跟答题卡同一副骨架（QuestionSlot 管它什么时候出、收起、收回）。一行一个任务：序号、标题、下面一行备注，
// 行尾是交给谁（同回复框那颗三段胶囊），指到这一行出一颗叉 = 这一条不派；点标题在左抽屉里读完整说明。
// 最后一行写了字，那颗键就从「派出去」变成「发回去改」。
//
// 派出去的就是卡上此刻的样子：留下的几行、各交给谁、一个接一个还是同时，原样交给 ash 去建
// （api.launchDispatchPlan），不经智能体再转一手。没碰过的那一格跟着「派出去的活交给谁」的默认值走。
import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { AgentType, TaskListItem } from "@ash/shared";
import { CaretDown, Check, X } from "@phosphor-icons/react";
import {
  DISPATCH_ORDER_LABEL, dispatchDefaultTarget,
  type DispatchLaunchInput, type DispatchOrder, type DispatchPlan, type DispatchRunTarget,
} from "@ash/shared/dispatch-plan";
import { questionKey, type QuestionAnswerInput } from "@ash/shared/questions";
import { RunTargetPicker } from "../components/RunTargetPicker.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { useLeftDrawer } from "../components/LeftDrawer.tsx";
import { executorRunSummary, registeredAgentTypes } from "../lib/agentAvailability.ts";
import { isSendKeyEvent } from "../lib/sendKey.ts";
import { useAutoGrowTextarea } from "../lib/useAutoGrowTextarea.ts";
import { useExecutorProfiles } from "./useExecutorProfiles.ts";

const ORDERS: DispatchOrder[] = ["serial", "parallel"];

export type DispatchPlanCardProps = {
  task: TaskListItem;
  plan: DispatchPlan;
  /** 摆单的是名下派出的那一条（不是这一页的任务）：它的标题。 */
  asker?: string;
  onLaunch: (input: DispatchLaunchInput) => Promise<void>;
  /** 发回去改：就是对那一问的普通答复。 */
  onAnswer: (answer: string, input: QuestionAnswerInput) => Promise<void>;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
};

/** 「同这里」落到这条任务自己身上；它自己也没定执行器时跟回复框胶囊同一个口径（claude）。 */
function fallbackTarget(task: TaskListItem): DispatchRunTarget {
  return dispatchDefaultTarget(task) ?? {
    agentType: (task.agentType ?? "claude") as AgentType, executorId: null, model: null, reasoningEffort: null,
  };
}

export function DispatchPlanCard({ task, plan, asker, onLaunch, onAnswer, collapsed, onCollapsedChange }: DispatchPlanCardProps) {
  const { profiles } = useExecutorProfiles();
  const drawer = useLeftDrawer();
  const [order, setOrder] = useState<DispatchOrder>(plan.order);
  const [dropped, setDropped] = useState<number[]>([]);
  // 只记你动过的那几格；没动过的跟着单子上指明的、或默认值走。
  const [picked, setPicked] = useState<Record<number, DispatchRunTarget>>({});
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const rowsRef = useRef<HTMLOListElement>(null);
  const keyId = useId();
  useAutoGrowTextarea(input, { value: note, maxLines: 6 });

  const fallback = fallbackTarget(task);
  const rows = plan.items.flatMap((item, index) => dropped.includes(index) ? [] : [{
    item, index, target: picked[index] ?? item.target ?? fallback,
  }]);
  const types = registeredAgentTypes(profiles);
  // 摆单的那一轮还在收尾：等它停下才派得出去、发得回去。
  const settling = task.status === "running" || task.status === "queued";
  const unavailable = settling || sending || sent;
  const returning = !!note.trim();
  const canSend = !unavailable && (returning || rows.length > 0);
  const label = asker ? `「${asker}」摆出的派活单` : "等你过目的派活单";

  const drop = (index: number, at: number) => {
    setDropped((list) => [...list, index]);
    // 叉没了，焦点落到下一行的叉上；最后一行就落进输入行。
    requestAnimationFrame(() => {
      const keys = rowsRef.current?.querySelectorAll<HTMLButtonElement>(".dispatch-plan-drop");
      (keys?.[Math.min(at, (keys?.length ?? 1) - 1)] ?? input.current)?.focus();
    });
  };
  const retarget = (index: number, next: DispatchRunTarget) => setPicked((map) => ({ ...map, [index]: next }));
  const read = (index: number, title: string) => {
    if (!drawer) return;
    const key = `dispatch-plan:${plan.id}:${index}`;
    if (drawer.activeKey === key) return drawer.close();
    drawer.open({
      key, kind: "派活单", title, ariaLabel: `完整说明：${title}`, closeLabel: "关上完整说明",
      body: <div className="dispatch-plan-reading"><MarkdownBody text={plan.items[index]!.body} /></div>,
    });
  };

  const submit = async () => {
    if (inFlight.current || !canSend) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    try {
      if (returning) await onAnswer(note.trim(), { questionKey: questionKey(task) });
      else await onLaunch({ planId: plan.id, order, items: rows.map((row) => ({ index: row.index, target: row.target })) });
      setSent(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  if (collapsed) {
    return (
      <section className="question-card dispatch-plan is-collapsed" aria-label={label}>
        <button type="button" className="question-card-peek" aria-expanded="false" onClick={() => onCollapsedChange(false)}>
          <span>{asker && <b className="question-card-asker">「{asker}」：</b>}派出这 {rows.length} 个任务</span>
          <CaretDown size={13} weight="bold" aria-hidden="true" />
        </button>
      </section>
    );
  }

  const sendLabel = sending ? (returning ? "发送中…" : "派出中…") : sent ? (returning ? "已发回" : "已派出") : returning ? "发回去改" : "派出去";
  return (
    <section className="question-card dispatch-plan" aria-label={label} aria-busy={sending}>
      <header className="question-card-head">
        <div className="question-card-prompt">
          {asker && <p className="question-card-asker">「{asker}」想派：</p>}
          <p className="dispatch-plan-title">派出这 {rows.length} 个任务</p>
        </div>
        <div className="question-card-tools">
          {!!dropped.length && (
            <button type="button" className="dispatch-plan-restore" disabled={unavailable} onClick={() => setDropped([])}>
              还原 {dropped.length} 条
            </button>
          )}
          <div className="dispatch-plan-order" role="group" aria-label="派出顺序">
            {ORDERS.map((value) => (
              <button type="button" key={value} aria-pressed={order === value} disabled={unavailable} onClick={() => setOrder(value)}>
                {DISPATCH_ORDER_LABEL[value]}
              </button>
            ))}
          </div>
          <button type="button" className="question-card-collapse" aria-expanded="true" aria-label="收起派活单，先看上文"
            onClick={() => onCollapsedChange(true)}>
            <CaretDown size={13} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </header>
      <ol className="dispatch-plan-rows" ref={rowsRef} aria-label="要派出的任务">
        {rows.map(({ item, index, target }, at) => {
          const executorId = target.executorId
            ?? profiles.find((profile) => profile.type === target.agentType && profile.isDefault)?.id ?? null;
          const summary = executorRunSummary({ agentType: target.agentType, executorId }, profiles,
            { model: target.model, effort: target.reasoningEffort });
          const who = profiles.find((profile) => profile.id === executorId)?.name ?? target.agentType;
          return (
            <li key={index} className="dispatch-plan-row">
              <span className="question-card-key" aria-hidden="true">{at + 1}</span>
              <span className="dispatch-plan-text">
                {drawer
                  ? <button type="button" className="dispatch-plan-name" aria-pressed={drawer.activeKey === `dispatch-plan:${plan.id}:${index}`}
                    aria-label={`第 ${at + 1} 条：${item.title}，读完整说明`} onClick={() => read(index, item.title)}>{item.title}</button>
                  : <b className="dispatch-plan-name">{item.title}</b>}
                {item.note && <small>{item.note}</small>}
              </span>
              <RunTargetPicker
                label={`第 ${at + 1} 条「${item.title}」交给 ${who}`}
                types={types.length ? types : [target.agentType]}
                profiles={profiles}
                selection={{ agentType: target.agentType, executorId }}
                model={summary.model ?? null}
                effort={summary.effort ?? ""}
                variant="chip"
                disabled={unavailable}
                onCommit={(next) => retarget(index, {
                  agentType: next.agent, executorId: next.executorId, model: next.model,
                  reasoningEffort: next.agent === target.agentType ? target.reasoningEffort : null,
                })}
                onEffortChange={(effort) => retarget(index, { ...target, reasoningEffort: effort || null })}
              />
              <button type="button" className="dispatch-plan-drop" disabled={unavailable}
                aria-label={`第 ${at + 1} 条「${item.title}」不派`} onClick={() => drop(index, at)}>
                <X size={12} weight="bold" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ol>
      <div className="question-card-note">
        <textarea ref={input} value={note} rows={1} disabled={unavailable} aria-label="补一句要求，或者说哪里不对"
          aria-describedby={keyId}
          placeholder={settling ? "这一轮结束后即可派出" : "补一句要求，或者说哪里不对…"}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (!isSendKeyEvent(event)) return;
            event.preventDefault();
            void submit();
          }}
        />
        <button type="button" className="question-card-send" disabled={!canSend} onClick={() => void submit()} aria-describedby={keyId}>
          {sent && <Check size={13} aria-hidden="true" />}
          {sendLabel}
        </button>
        <span id={keyId} className="task-visually-hidden">
          {returning ? "把这句话发回去，一条任务都不建" : rows.length ? `按卡上的样子派出 ${rows.length} 个任务，${DISPATCH_ORDER_LABEL[order]}` : "全去掉了，写一句发回去"}
        </span>
      </div>
      {error && <p className="question-card-error" role="alert">{error}</p>}
    </section>
  );
}
