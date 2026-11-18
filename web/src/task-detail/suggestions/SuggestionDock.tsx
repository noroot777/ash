// 回复框顶上那一行「可以派出去的活」：位置和画法同「等你裁定」那一行（ReplyDock.tsx 的骨架、reply-dock.css）。
// 一件时：记号、标题（点它 = 选中）、交给谁那颗胶囊、谁来审、描边的「派出去」、指到才出的叉。选中时下面多一段：一句为什么、
// 从哪开工、完整说明；这时下面的输入区是「补一句」，右下角那颗写着「派出去」，所以行尾那颗不重复出现。
// 好几件时平时只占一行「N 件可以派出去」，点开一行一件，多一组「同时 / 一个接一个」和「全部派出去」。
// 状态和派出去那一下都在 useSuggestionDock.tsx，这里只画。
import type { KeyboardEvent } from "react";
import type { AgentExecutorProfile, AgentType, ReviewerProfile } from "@ash/shared";
import { DISPATCH_ORDER_LABEL, type DispatchOrder, type DispatchRunTarget } from "@ash/shared/dispatch-plan";
import type { DispatchSuggestionBase } from "@ash/shared/dispatch-suggestion";
import type { CreateReviewChoice } from "@ash/shared/review-on-create";
import { sameExecutor } from "@ash/shared/executors";
import { ArrowBendUpRight, CaretDown, X } from "@phosphor-icons/react";
import { RunTargetPicker } from "../../components/RunTargetPicker.tsx";
import { ReviewerChip } from "../../free-workflow/ReviewerChip.tsx";
import { executorRunSummary } from "../../lib/agentAvailability.ts";

export type SuggestionRow = {
  id: string;
  title: string;
  note: string;
  target: DispatchRunTarget;
  review: CreateReviewChoice;
  base: DispatchSuggestionBase;
  /** 标题和说明都还在：派得出去。 */
  filled: boolean;
};

export type SuggestionDockProps = {
  rows: SuggestionRow[];
  armedId: string | null;
  /** 好几件时那一段展开着。 */
  open: boolean;
  order: DispatchOrder;
  /** 可选的开工起点（只有一处可开工时为空，那一组不出）。 */
  bases: { id: DispatchSuggestionBase; label: string }[];
  readingId: string | null;
  busy: boolean;
  /** 此刻派不出去的原因（还在确认从哪开工…）：「派出去」那几颗灰着，叉照常能点。 */
  held: string | null;
  error: string | null;
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  /** null = 审查者清单还没读到。 */
  reviewers: ReviewerProfile[] | null;
  onArm: (id: string) => void;
  onGo: (id: string) => void;
  onDrop: (id: string) => void;
  onRetarget: (id: string, target: DispatchRunTarget) => void;
  onReview: (id: string, review: CreateReviewChoice) => void;
  onBase: (id: string, base: DispatchSuggestionBase) => void;
  onRead: (id: string) => void;
  onToggle: () => void;
  onOrder: (order: DispatchOrder) => void;
  onAll: () => void;
  /** 焦点在这一行里按 Esc；接走了给 true。 */
  onEscape: () => boolean;
};

const ORDERS: DispatchOrder[] = ["parallel", "serial"];

function Row({ row, at, props }: { row: SuggestionRow; at: number | null; props: SuggestionDockProps }) {
  const { profiles, types, armedId, busy } = props;
  const armed = armedId === row.id;
  const target = row.target;
  const executorId = target.executorId ?? profiles.find((profile) => profile.type === target.agentType && profile.isDefault)?.id ?? null;
  const summary = executorRunSummary({ agentType: target.agentType, executorId }, profiles, { model: target.model, effort: target.reasoningEffort });
  const who = profiles.find((profile) => profile.id === executorId)?.name ?? target.agentType;
  const title = row.title || "没写标题";
  return (
    <>
      <div className="sg-row">
        {at === null ? <ArrowBendUpRight size={14} className="sg-mark" aria-hidden="true" /> : <span className="sg-key" aria-hidden="true">{at}</span>}
        <button type="button" className="sg-name" aria-pressed={armed} onClick={() => props.onArm(row.id)}
          aria-label={armed ? `「${title}」已选中，再点一下退出` : `选中「${title}」，补一句再派`}>
          <span>{title}</span>
        </button>
        <span className="sg-gap" aria-hidden="true" />
        <RunTargetPicker
          label={`「${title}」交给 ${who}`}
          types={types.length ? types : [target.agentType]}
          profiles={profiles}
          selection={{ agentType: target.agentType, executorId }}
          model={summary.model ?? null}
          effort={summary.effort ?? ""}
          variant="chip"
          disabled={busy}
          // 换了执行器（同类型的另一个 profile 也算）智能水平回到跟随：旧档位在新配置上未必有（同 useReplyCall.ts）。
          onCommit={(next) => props.onRetarget(row.id, {
            agentType: next.agent, executorId: next.executorId, model: next.model,
            reasoningEffort: sameExecutor({ agentType: next.agent, executorId: next.executorId }, { agentType: target.agentType, executorId })
              ? target.reasoningEffort : null,
          })}
          onEffortChange={(effort) => props.onRetarget(row.id, { ...target, reasoningEffort: effort || null })}
        />
        <ReviewerChip value={row.review} reviewers={props.reviewers} label={`「${title}」`} disabled={busy}
          onChange={(review) => props.onReview(row.id, review)} />
        {!armed && (
          <button type="button" className="sg-go" disabled={busy || !!props.held || !row.filled} onClick={() => props.onGo(row.id)}
            aria-label={`把「${title}」派出去`}>派出去</button>
        )}
        <button type="button" className="sg-drop" disabled={busy} aria-label={`不派「${title}」`} onClick={() => props.onDrop(row.id)}>
          <X size={11} weight="bold" aria-hidden="true" />
        </button>
      </div>
      {armed && (
        <div className="sg-detail">
          {row.note && <p>{row.note}</p>}
          {props.bases.length > 1 && (
            <div className="sg-seg" role="group" aria-label="从哪开工">
              {props.bases.map((base) => (
                <button type="button" key={base.id} aria-pressed={row.base === base.id} disabled={busy}
                  onClick={() => props.onBase(row.id, base.id)}>{base.label}</button>
              ))}
            </div>
          )}
          <button type="button" className="sg-read" aria-pressed={props.readingId === row.id} onClick={() => props.onRead(row.id)}>完整说明</button>
        </div>
      )}
    </>
  );
}

export function SuggestionDock(props: SuggestionDockProps) {
  const { rows, open, busy } = props;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (props.onEscape()) event.preventDefault();
  };
  const error = props.error && <p className="reply-dock-error" role="alert">{props.error}</p>;
  if (rows.length === 1) {
    return (
      <div className="reply-dock sg" role="group" aria-label="可以派出去的活" onKeyDown={onKeyDown}>
        <Row row={rows[0]!} at={null} props={props} />
        {error}
      </div>
    );
  }
  return (
    <div className="reply-dock sg" role="group" aria-label="可以派出去的活" onKeyDown={onKeyDown}>
      <div className="sg-row">
        <ArrowBendUpRight size={14} className="sg-mark" aria-hidden="true" />
        <button type="button" className="sg-name" aria-expanded={open} onClick={props.onToggle}>
          <span>{rows.length} 件可以派出去</span>
          <CaretDown size={11} weight="bold" aria-hidden="true" />
        </button>
        <span className="sg-gap" aria-hidden="true" />
        {open && (
          <>
            <div className="sg-seg" role="group" aria-label="派出顺序">
              {ORDERS.map((value) => (
                <button type="button" key={value} aria-pressed={props.order === value} disabled={busy}
                  onClick={() => props.onOrder(value)}>{DISPATCH_ORDER_LABEL[value]}</button>
              ))}
            </div>
            <button type="button" className="sg-go" disabled={busy || !!props.held || !rows.every((row) => row.filled)} onClick={props.onAll}>全部派出去</button>
          </>
        )}
      </div>
      {open && (
        <ol className="sg-list" aria-label="可以派出去的活">
          {rows.map((row, at) => <li key={row.id}><Row row={row} at={at + 1} props={props} /></li>)}
        </ol>
      )}
      {error}
    </div>
  );
}
