import type { TaskDiscussion, TaskListItem } from "@ash/shared";
import type { LeftDrawerEntry } from "../components/LeftDrawer.tsx";
import {
  discussionLive, discussionPair, discussionSegmentHead, discussionSegments, discussionSpeaking, discussionTotal,
  discussionWaiting,
} from "./discussionModel.ts";
import { TalkOverview } from "./TalkOverview.tsx";
import { TalkRecord } from "./TalkRecord.tsx";
import { useFreeWorkflowSnapshot } from "./useFreeWorkflowState.ts";

/**
 * 一场讨论的概览：一段一行，左边写谁、右边是那一段的一句话，点一行左侧抽屉停在那一段。会话里那颗气泡就地
 * 摊开的、「审议」格里那一段，是这同一个组件（画法同辩论，都是 TalkOverview）。
 */
export function DiscussionOverview({ discussion, onOpen }: { discussion: TaskDiscussion; onOpen?: (seq: number) => void }) {
  return (
    <TalkOverview
      label="讨论概览"
      className="is-named"
      segments={discussionSegments(discussion)}
      waiting={discussionWaiting(discussion)}
      onOpen={onOpen}
    />
  );
}

export type DiscussionDrawerSource = {
  task: Pick<TaskListItem, "id">;
  discussionId: string;
  /** 停在第几段；不给就从头。 */
  seq?: number;
  /** 开的那一刻手上那份记录：这个页面上没人在拉状态时（夹具）照它画。 */
  discussions: readonly TaskDiscussion[] | null | undefined;
};

/** 跟着长：这个任务页上已经有人在拉自由工作流状态，这里只跟着看。 */
function useDiscussion(source: DiscussionDrawerSource): TaskDiscussion | null {
  const live = useFreeWorkflowSnapshot(source.task.id)?.discussions ?? source.discussions;
  return live?.find((item) => item.id === source.discussionId) ?? null;
}

function DiscussionRecordTitle({ source }: { source: DiscussionDrawerSource }) {
  const discussion = useDiscussion(source);
  if (!discussion) return <>讨论</>;
  if (discussion.status === "running") {
    return <>{`${discussionPair(discussion)} · 正在说第 ${discussionSpeaking(discussion).seq} / ${discussionTotal(discussion)} 段`}</>;
  }
  const done = discussion.turns.filter((turn) => turn.status === "done").length;
  return <>{`${discussionPair(discussion)} · ${done} 段${discussionLive(discussion) ? " · 在写合稿" : ""}`}</>;
}

/** 讨论的完整记录：一段一节，节头是谁、第几段（第一轮写明各写各的），下面是那句摘要和完整发言；讨论中它跟着长。 */
function DiscussionRecordBody({ source }: { source: DiscussionDrawerSource }) {
  const discussion = useDiscussion(source);
  if (!discussion) return <p className="debate-record-missing">这场讨论的记录还没读到。</p>;
  return (
    <TalkRecord
      segments={discussionSegments(discussion)}
      waiting={discussionWaiting(discussion)}
      focus={source}
      headOf={(segment) => discussionSegmentHead(discussion, segment.seq)}
    />
  );
}

/** 左侧抽屉里那一屉：一场讨论一个 key，再开同一场 = 换停的那一段。跟子智能体、辩论那几屉同一个位置，互斥。 */
export function discussionDrawerEntry(source: DiscussionDrawerSource): LeftDrawerEntry {
  return {
    key: `discussion:${source.task.id}:${source.discussionId}`,
    kind: "讨论",
    title: <DiscussionRecordTitle source={source} />,
    ariaLabel: "讨论的完整记录",
    closeLabel: "关闭讨论记录",
    body: <DiscussionRecordBody source={source} />,
  };
}
