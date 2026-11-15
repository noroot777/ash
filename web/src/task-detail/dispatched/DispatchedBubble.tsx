import { BubbleShell } from "../BubbleShell.tsx";
import { formatInstant } from "../utils.ts";
import type { DispatchBubble as Bubble, DispatchBubbleState } from "./dispatchSignals.ts";

// 派出的任务来问 / 失败的那一刻：会话右边一颗气泡，跟审查者那颗同一副骨架（BubbleShell）。它是对这条
// 任务说话的那一方，所以跟你的话同一列。气泡里是那条任务的标题（加重）和题目 / 原因的头一句；指到
// 才浮出「派出的任务 · 执行器 · 在等答复」那一行。点气泡在左边抽屉里打开那条任务。
//
// 状态只在浮出那一行里说一次（还在等的，字前一颗静止的琥珀点；失败的一颗红点）；那条任务后来
// 怎样（重试了、过了），看右侧「派出的任务」那一格。

const WORD: Record<DispatchBubbleState, string> = {
  waiting: "在等答复",
  answered: "已答复",
  closed: "不再等答复",
  failed: "失败了",
};

const DOT: Partial<Record<DispatchBubbleState, string>> = { waiting: "wait", failed: "bad" };

export function DispatchedBubble({ bubble, onOpen }: { bubble: Bubble; onOpen?: (taskId: string) => void }) {
  const word = WORD[bubble.state];
  const dot = DOT[bubble.state];
  const meta = [bubble.executor, word, formatInstant(bubble.at)].filter(Boolean).join(" · ");
  const body = (
    <>
      {dot && <span className={`workspace-status-dot workspace-status-dot--${dot} review-progress-dot`} aria-hidden="true" />}
      <span className="debate-bubble-say" data-selection-content="">
        <b>{bubble.title}</b>{bubble.text}
      </span>
    </>
  );
  return (
    <BubbleShell className={`dispatched-bubble is-${bubble.state}`} name="派出的任务" meta={meta}>
      {onOpen ? (
        <button
          type="button"
          className="review-verdict-text"
          aria-label={`派出的任务「${bubble.title}」${word}：${bubble.text}，在左边打开它`}
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
