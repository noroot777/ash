// 答题卡停在回复框那一格（三个宿主同一副形状：任务页、远程任务页、团队页的调度者提问）。
//
// 有问题在等：展开着的时候卡就是回复框——平常那个框不出现（`hidden`，草稿、附件、拖出来的高度都在，
// 只是不画），任何时候都只有一处打字的地方、一颗发送键；收起时卡缩成题目一行，平常的回复框回到它
// 下面。卡从下面升上来，答完原路收回去；收回去那 200ms 里卡片还是答完那一刻的样子，但点不动
// （inert），回复框等它走了才出来。
import { cloneElement, useEffect, useState, type ReactElement } from "react";
import type { TaskListItem } from "@ash/shared";
import { questionKey, type QuestionAnswerInput } from "@ash/shared/questions";
import { motionReduced } from "../lib/useSwapText.ts";
import { QuestionCard } from "./QuestionCard.tsx";

const LEAVE_MS = 200;

/** 平常那个回复框：卡展开时给它 `hidden`。 */
export type ReplyBoxElement = ReactElement<{ hidden?: boolean }>;

export function QuestionSlot({ task, onAnswer, box }: {
  task: TaskListItem;
  onAnswer: (answer: string, input: QuestionAnswerInput) => Promise<void>;
  box: ReplyBoxElement;
}) {
  const asking = task.question ? task : null;
  const [shown, setShown] = useState<TaskListItem | null>(asking);
  const [leaving, setLeaving] = useState(false);
  // 收起记在这一次提问上：换了一道题（或换了任务）就重新展开。
  const [collapsedKey, setCollapsedKey] = useState<string | null>(null);
  useEffect(() => {
    if (asking) {
      setShown(asking);
      setLeaving(false);
      return;
    }
    if (!shown || motionReduced()) {
      setShown(null);
      return;
    }
    setLeaving(true);
    const timer = window.setTimeout(() => { setShown(null); setLeaving(false); }, LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [asking]);
  const card = asking ?? shown;
  const key = card ? `${card.id}:${questionKey(card)}` : null;
  const collapsed = !!key && collapsedKey === key;
  const covering = !!card && !collapsed;
  return <>
    {card && (
      <div className={`question-dock${leaving && !asking ? " is-leaving" : ""}`} inert={leaving && !asking ? true : undefined}>
        <QuestionCard key={key} task={card} onAnswer={onAnswer} collapsed={collapsed}
          onCollapsedChange={(next) => setCollapsedKey(next ? key : null)} />
      </div>
    )}
    {cloneElement(box, { hidden: covering || undefined })}
  </>;
}

/** 没有答题卡的宿主：框原样摆在那一格。 */
export const keepReplyBox = (box: ReplyBoxElement) => box;
