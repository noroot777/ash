import { BubbleShell } from "../BubbleShell.tsx";
import { formatInstant } from "../utils.ts";
import type { DispatchBubble as Bubble } from "./dispatchSignals.ts";

// 派出的任务失败的那一刻：会话右边一颗气泡，跟审查者那颗同一副骨架（BubbleShell）。它是对这条
// 任务说话的那一方，所以跟你的话同一列。气泡里是那条任务的标题（加重）和原因的头一句，字前一颗
// 红点；指到才浮出「派出的任务 · 执行器 · 失败了」那一行。点气泡在左边抽屉里打开那条任务。
//
// 那条任务后来怎样（重试了、过了），看右侧「派出的任务」那一格。

const WORD = "失败了";

export function DispatchedBubble({ bubble, onOpen }: { bubble: Bubble; onOpen?: (taskId: string) => void }) {
  const meta = [bubble.executor, WORD, formatInstant(bubble.at)].filter(Boolean).join(" · ");
  const body = (
    <>
      <span className="workspace-status-dot workspace-status-dot--bad review-progress-dot" aria-hidden="true" />
      <span className="debate-bubble-say" data-selection-content="">
        <b>{bubble.title}</b>{bubble.text}
      </span>
    </>
  );
  return (
    <BubbleShell className="dispatched-bubble is-failed" name="派出的任务" meta={meta}>
      {onOpen ? (
        <button
          type="button"
          className="review-verdict-text"
          aria-label={`派出的任务「${bubble.title}」${WORD}：${bubble.text}，在左边打开它`}
          onClick={() => onOpen(bubble.taskId)}
        >
          {body}
        </button>
      ) : (
        <p className="review-verdict-text is-static" tabIndex={0}>{body}</p>
      )}
    </BubbleShell>
  );
}
