// 答题卡停在回复框那一格（三个宿主同一副形状：任务页 ReplyBox、远程任务页、团队页 TeamReplyBox）。
//
// 有问题在等：展开着的时候卡就是回复框——宿主照 `covering` 让平常那个框整个不挂（草稿、附件、拖出来
// 的高度都在宿主的状态里，收起时原样回来），框外挂着的补全、引用、选模型这些浮层也一并退下：接管的
// 是整套输入工具，不只是框本体。只藏不卸是挡不住的：选执行器、发送设置、截图批注都 portal 到 body
// 上，祖先 `hidden` 管不到它们。任何时候都只有一处打字的地方、一颗发送键。收起时卡缩成题目一行，
// 平常的回复框回到它下面。卡从下面升上来，答完原路收回去；收回去那 200ms 里卡片还是答完那一刻的
// 样子，但点不动（inert），回复框等它走了才出来。
import { useEffect, useState } from "react";
import type { TaskListItem } from "@navi/shared";
import { questionKey, type QuestionAnswerInput } from "@navi/shared/questions";
import { motionReduced } from "../lib/useSwapText.ts";
import { QuestionCard } from "./QuestionCard.tsx";

const LEAVE_MS = 200;

export type QuestionTakeover = {
  /** 此刻画着的那一题（答完收回去的 200ms 里还是它）。 */
  card: TaskListItem | null;
  leaving: boolean;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** 卡展开着（含收回去那一下）：平常的回复框和它的浮层都不挂。 */
  covering: boolean;
};

/** `task` 给 null = 这个宿主不接答题卡（没有答复的路）。 */
export function useQuestionTakeover(task: TaskListItem | null): QuestionTakeover {
  const asking = task?.question ? task : null;
  const [shown, setShown] = useState<TaskListItem | null>(asking);
  const [leaving, setLeaving] = useState(false);
  // 收起记在这一次提问上：换了一道题（或换了任务）就重新展开；题走了就忘掉，同一句话再问一次也是新的一次。
  // 那一问是一批派活在等（shared/src/dispatch-suggestion.ts）时，任务页由回复框顶上那一行接住、不传给这里
  // （ReplyBox `holdsQuestion`）；派不出去的宿主（远程任务页）照普通提问画：清单那句话是题目，回一句话就是发回去改。
  const [collapsedKey, setCollapsedKey] = useState<string | null>(null);
  useEffect(() => {
    if (asking) {
      setShown(asking);
      setLeaving(false);
      return;
    }
    const gone = () => { setShown(null); setLeaving(false); setCollapsedKey(null); };
    if (!shown || motionReduced()) {
      gone();
      return;
    }
    setLeaving(true);
    const timer = window.setTimeout(gone, LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [asking]);
  const card = asking ?? shown;
  const key = card ? cardKey(card) : null;
  const collapsed = !!key && collapsedKey === key;
  return {
    card,
    leaving: leaving && !asking,
    collapsed,
    setCollapsed: (next) => setCollapsedKey(next ? key : null),
    covering: !!card && !collapsed,
  };
}

// 等着的一批派活摆第二批时题面可能一字不差：带上那一批的号，换一批就是新的一次。
const cardKey = (task: TaskListItem) =>
  `${task.id}:${questionKey(task)}:${(task.dispatchSuggestions ?? []).find((item) => item.wait !== "none")?.batch ?? ""}`;

/**
 * 卡本身，摆在宿主的回复框那一格（展开时框不挂，卡就占了那一格；收起时框在它下面）。卡只会是宿主
 * 自己的：名下子任务来问、摆单，卡在那一条自己的页面上，不借这一格。
 */
export function QuestionDock({ takeover, onAnswer, attachable }: {
  takeover: QuestionTakeover;
  onAnswer: (answer: string, input: QuestionAnswerInput, attachments?: string[]) => Promise<void>;
  /** 答复能带本机附件（贴图）。远程任务页不给：对端读不到本机路径。 */
  attachable?: boolean;
}) {
  const { card, leaving } = takeover;
  if (!card) return null;
  return (
    <div className={`question-dock${leaving ? " is-leaving" : ""}`} inert={leaving ? true : undefined}>
      <QuestionCard key={cardKey(card)} task={card} onAnswer={onAnswer} attachable={attachable}
        collapsed={takeover.collapsed} onCollapsedChange={takeover.setCollapsed} />
    </div>
  );
}
