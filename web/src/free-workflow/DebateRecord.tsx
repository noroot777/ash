import type { FreeReviewDebate, FreeReviewDisputeTarget, FreeReviewRun, TaskListItem } from "@navi/shared";
import type { LeftDrawerEntry } from "../components/LeftDrawer.tsx";
import { DEBATE_SIDE_LABEL, DEBATE_VERDICT_LABEL, debateSpeaking, debateTotalSegments } from "./debateModel.ts";
import { QuoteKey } from "./TalkOverview.tsx";
import { TalkRecord } from "./TalkRecord.tsx";
import { useRulingQuote } from "./disputeRulingStore.ts";
import { useFreeWorkflowSnapshot } from "./useFreeWorkflowState.ts";

export type DebateDrawerSource = {
  task: Pick<TaskListItem, "id">;
  target: FreeReviewDisputeTarget;
  debateId: string;
  /** 同一条驳回辩过多次时的第几次（只有一次就是 null）。 */
  ordinal: number | null;
  /** 停在第几段（概览里点的那一行）；不给就从头。 */
  seq?: number;
  /** 开的那一刻手上那份记录：这个页面上没人在拉审查状态时（夹具）照它画。 */
  reviews: readonly FreeReviewRun[] | null | undefined;
};

function findDebate(reviews: readonly FreeReviewRun[] | null | undefined, debateId: string): FreeReviewDebate | null {
  for (const run of reviews ?? []) {
    for (const round of run.rounds) {
      const hit = round.dispute?.debates.find((debate) => debate.id === debateId);
      if (hit) return hit;
    }
  }
  return null;
}

/** 跟着长：这个任务页上已经有人在拉审查状态，这里只跟着看。 */
function useLiveReviews(source: DebateDrawerSource) {
  return useFreeWorkflowSnapshot(source.task.id)?.reviews ?? source.reviews;
}

function DebateRecordTitle({ source }: { source: DebateDrawerSource }) {
  const debate = findDebate(useLiveReviews(source), source.debateId);
  const head = `第 ${source.target.round} 轮${source.ordinal ? ` · 第 ${source.ordinal} 次` : ""}`;
  if (!debate) return <>{head}</>;
  const total = debateTotalSegments(debate);
  if (debate.status === "running") return <>{`${head} · 正在说第 ${debateSpeaking(debate).seq} / ${total} 段`}</>;
  return <>{`${head} · 审查者和执行者 · ${debate.turns.filter((turn) => turn.status === "done").length} 段`}</>;
}

/**
 * 辩论的完整记录：一段一节，节头是谁、第几段，收尾那段写明它自己的立场；下面先是那句摘要，再是完整
 * 发言。辩论中它跟着长。等裁定时每一节也有「用这段作要点」：点了那一句落进回复框、选中「让它接着改」，
 * 抽屉收起（按不按得动跟回复框顶上那一行同一份登记，不看打开那一刻的任务）。它取代了原来那个盖住整页的阅读层——位置跟子智能体那个抽屉一样，右边的审查格照样点得着。
 */
function DebateRecordBody({ source }: { source: DebateDrawerSource }) {
  const reviews = useLiveReviews(source);
  const debate = findDebate(reviews, source.debateId);
  const quote = useRulingQuote(source.task.id, source.target);
  if (!debate) return <p className="debate-record-missing">这场辩论的记录还没读到。</p>;
  const total = debateTotalSegments(debate);
  const next = debate.status === "running" && !debate.turns.some((turn) => turn.status === "speaking") ? debateSpeaking(debate) : null;
  return (
    <TalkRecord
      segments={debate.turns.map((turn) => ({ ...turn, who: DEBATE_SIDE_LABEL[turn.side] }))}
      waiting={next && { seq: next.seq, who: DEBATE_SIDE_LABEL[next.side] }}
      focus={source}
      headOf={(segment) => segment.seq === total && debate.status === "finished"
        ? `收尾，它自己的立场：${debate.verdict ? DEBATE_VERDICT_LABEL[debate.verdict] : "没给"}` : null}
      keyOf={(segment) => {
        const turn = debate.turns.find((item) => item.seq === segment.seq);
        return quote && turn?.statement ? <QuoteKey onQuote={() => quote(turn)} /> : null;
      }}
    />
  );
}

/** 左侧抽屉里那一屉：一场辩论一个 key，再开同一场 = 换停的那一段。 */
export function debateDrawerEntry(source: DebateDrawerSource): LeftDrawerEntry {
  return {
    key: `debate:${source.task.id}:${source.debateId}`,
    kind: "辩论",
    title: <DebateRecordTitle source={source} />,
    ariaLabel: `辩论的完整记录：第 ${source.target.round} 轮审查意见`,
    closeLabel: "关闭辩论记录",
    body: <DebateRecordBody source={source} />,
  };
}
