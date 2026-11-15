import { useId, useState } from "react";
import type { FreeReviewDisputeTarget, FreeReviewRun, TaskListItem } from "@ash/shared";
import { MAX_FREE_REVIEW_DEBATE_EXCHANGES } from "@ash/shared/free-workflow";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { useRovingChoice } from "../lib/useRovingChoice.ts";
import { focusReplyInput } from "../task-detail/replyQuote.ts";
import type { ReplyOverride } from "../task-detail/replyOverride.ts";
import { ReplyDockRow, ReplyDockSend } from "../task-detail/ReplyDock.tsx";
import {
  DEBATE_CHOICE, RESOLUTIONS, UPHELD_AFTER_DEBATE, choiceTip, exchangesText, resolvedText,
} from "./disputeCopy.ts";
import { openDisputeTarget, rulingContext, sameDisputeTarget, type RulingChoice, type RulingContext } from "./disputeRuling.ts";
import { clearRulingDraft, submitRuling, useRulingDockPresence, useRulingDraft } from "./disputeRulingStore.ts";

const EXCHANGES = Array.from({ length: MAX_FREE_REVIEW_DEBATE_EXCHANGES }, (_, index) => String(index + 1));

const choiceLabel = (choice: RulingChoice) => (choice === "debate" ? DEBATE_CHOICE.button : RESOLUTIONS[choice].button);
const sendLabel = (choice: RulingChoice) => (choice === "debate" ? DEBATE_CHOICE.send : RESOLUTIONS[choice].send);

function tipOf(choice: RulingChoice, context: RulingContext): string {
  if (choice === "debate") return DEBATE_CHOICE.tip;
  const tip = choiceTip(choice, context.target.round);
  return choice === "upheld" && context.debated ? `${tip}${UPHELD_AFTER_DEBATE}` : tip;
}

/** 那一行真的画出来了才登记（答题卡展开时回复框不挂，它也就不在）；「用这段作要点」认这份登记。 */
function DockPresence({ taskId, context }: { taskId: string; context: RulingContext }) {
  useRulingDockPresence(taskId, context.target, !!context.blocked);
  return null;
}

function ExchangesPicker({ value, busy, onChange, onCancel }: {
  value: number;
  busy: boolean;
  onChange: (value: number) => void;
  onCancel: () => void;
}) {
  const roving = useRovingChoice(EXCHANGES, String(value), (next) => onChange(Number(next)));
  const labelId = useId();
  return (
    <div className="ruling-exchanges" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCancel(); } }}>
      <span id={labelId}>来回</span>
      <div {...roving.groupProps} aria-labelledby={labelId} className="ruling-exchanges-seg">
        {EXCHANGES.map((count) => (
          <button key={count} type="button" {...roving.itemProps(count)} disabled={busy} onClick={() => onChange(Number(count))}>{count}</button>
        ))}
      </div>
      <small>{exchangesText(value)}</small>
    </div>
  );
}

/**
 * 有一条驳回等你裁定时，回复框顶上多出的那一行：几种下一步，纯文字的切换键。点一颗，回复框就变成
 * 那一步——要交代的话写在框里（选填），发送键写着这一按的名字；再点同一颗、或按 Esc，回到平常的回复。
 * 先选一档、再按写着动作的键，这两步就是确认，不弹确认框（用户 2026-11-15）。
 *
 * 几种下一步各自的后果和先后规矩没变（服务端的接口和语义一律照旧）：
 * - 让它接着改（记为维持审查意见）：驳回不被采纳，接着发起修复；写的话压过报告。
 * - 这一轮不用改了（记为采纳执行者）：这条未通过意见作废；审查记录与证据原样留着，那一场也**不会**被
 *   改写成「已通过」——替审查者签字比留一条「用户裁定作废」的记录危险得多。
 * - 转为独立任务：意见**成立**，只是偏离了本任务要做的那件事（判据见 `@ash/shared/free-workflow` 的
 *   `DEFER_BOUNDARY_CRITERION`）。建一个待办派生任务把它带走。只在执行者逐条写明越界依据时才出现。
 * - 让双方辩论：先听几段再决定，**不改变任何结论**，辩完还是回到这一行拍板。
 *
 * 这一行出不出、出哪几颗见 `rulingContext`。有问题在等时，答题卡展开着就占着回复框那一格，回复框连同
 * 这一行一起不挂；收起后回复框带着它回来（ReplyBox 按 `covering` 卸框）——任何时候只有一处打字的地方。
 * 选中的那一档和写的话连同它针对的那一条驳回一起存
 * （`disputeRulingStore`），驳回换了一条就跟着旧那条走掉。
 */
export function useDisputeRulingDock({ task, reviews, known, onChanged, notify }: {
  task: Pick<TaskListItem, "id" | "status" | "stage" | "archived" | "handoff">;
  reviews: readonly FreeReviewRun[] | null | undefined;
  /** 审查状态已经读到。 */
  known: boolean;
  onChanged: (state: FreeWorkflowApiState) => void;
  notify: (message: string) => void;
}): ReplyOverride | undefined {
  // 交出去到回来之间（`busy`）草稿不收写入：框只读、键按不动、哪儿都引不进来，见 disputeRulingStore。
  const { draft, update, submitting: busy } = useRulingDraft(task.id, openDisputeTarget(reviews), known);
  const [failure, setFailure] = useState<{ target: FreeReviewDisputeTarget; text: string } | null>(null);
  const context = rulingContext(reviews, task);
  if (!context) return undefined;
  const choice = draft?.choice && context.choices.includes(draft.choice) ? draft.choice : null;
  const error = failure && sameDisputeTarget(failure.target, context.target) ? failure.text : null;
  const held = context.blocked ?? (busy ? "正在交，回来之前改不了" : null);

  const cancel = () => {
    update((current) => ({ ...current, choice: null }));
    focusReplyInput(task.id);
  };
  const pick = (next: RulingChoice) => {
    if (next === choice) return cancel();
    update((current) => ({ ...current, choice: next }));
    if (next !== "debate") focusReplyInput(task.id);
  };

  const submit = async () => {
    if (!draft || !choice || busy || context.blocked) return;
    // 提交只认选的那一刻定下的那一条；它已经不在等裁定时服务端如实拒，不替用户换人。
    const target = draft.target;
    setFailure(null);
    await submitRuling(task.id, async () => {
      try {
        if (choice === "debate") {
          const result = await api.startFreeReviewDebate(task.id, draft.exchanges, target);
          onChanged(result.state);
          // 辩完还是回到这一行拍板：写了一半的要点留着。
          clearRulingDraft(task.id, target, true);
          notify(`已开始辩论：审查者先说，共 ${draft.exchanges * 2 + 1} 段；说完还是由你裁定`);
        } else {
          const written = draft.note.trim();
          const result = await api.resolveFreeReviewDispute(task.id, choice, written || null, target);
          onChanged(result.state);
          clearRulingDraft(task.id, target);
          notify(resolvedText(choice, target.round, result, !!written));
        }
      } catch (reason) {
        // 失败时选中的那一档和写的话原样留着，说清楚哪儿没成。
        setFailure({ target, text: reason instanceof Error ? reason.message : choice === "debate" ? "发起辩论失败" : "裁定失败" });
      }
    });
  };

  const head = (
    <ReplyDockRow
      label="怎么裁定这条驳回"
      choices={context.choices.map((item) => ({ id: item, label: choiceLabel(item), tip: tipOf(item, context), held }))}
      pressed={choice}
      onPick={pick}
      onEscape={choice ? cancel : undefined}
      error={error}
    >
      <DockPresence taskId={task.id} context={context} />
    </ReplyDockRow>
  );

  return {
    head,
    take: !choice ? null
      : choice === "debate"
        ? { body: <ExchangesPicker value={draft?.exchanges ?? 1} busy={busy} onChange={(exchanges) => update((current) => ({ ...current, exchanges }))} onCancel={cancel} /> }
        : {
          input: {
            value: draft?.note ?? "",
            placeholder: RESOLUTIONS[choice].placeholder,
            label: `${RESOLUTIONS[choice].button}：${RESOLUTIONS[choice].placeholder}`,
            readOnly: busy,
            onChange: (note) => update((current) => ({ ...current, note })),
          },
        },
    send: choice ? <ReplyDockSend label={sendLabel(choice)} busy={busy} disabled={!!context.blocked} onSend={() => void submit()} /> : null,
    submit: () => void submit(),
    cancel,
  };
}
