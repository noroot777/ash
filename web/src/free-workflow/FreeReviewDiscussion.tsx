import type { TaskDiscussion, TaskListItem } from "@navi/shared";
import { ArrowsOutSimple } from "@phosphor-icons/react";
import { useLeftDrawer } from "../components/LeftDrawer.tsx";
import { InspRecord, InspTool } from "../inspector/parts.tsx";
import { DiscussionOverview, discussionDrawerEntry, type DiscussionDrawerSource } from "./DiscussionRecord.tsx";
import { discussionLive, discussionMeta, discussionNowText, discussionStatusLabel, discussionTotal } from "./discussionModel.ts";

/** 「审议」格里一场讨论那一条的 key（跟审查各轮的 `reviewKey` 同一张表里认开合、认滚到哪）。 */
export const discussionKey = (id: string) => `discussion:${id}`;

/**
 * 「审议」格里的一场讨论：跟审查各轮排在同一列记录里、按开始时间排。点开是每段一行的概览——跟会话里那颗
 * 讨论气泡就地摊开的是同一个组件（DiscussionOverview）——外加一颗展开键，左侧抽屉读完整记录。
 * `here`：刚从会话里那颗气泡点过来，这一条亮一下。
 */
export function FreeReviewDiscussion({ task, discussion, discussions, open, here, onToggle }: {
  task: Pick<TaskListItem, "id">;
  discussion: TaskDiscussion;
  discussions: readonly TaskDiscussion[];
  open: boolean;
  here: boolean;
  onToggle: () => void;
}) {
  const drawer = useLeftDrawer();
  const key = discussionKey(discussion.id);
  const source = (seq?: number): DiscussionDrawerSource => ({ task, discussionId: discussion.id, seq, discussions });
  const entryKey = discussionDrawerEntry(source()).key;
  const live = discussionLive(discussion);
  const done = discussion.turns.filter((turn) => turn.status === "done").length;
  const count = discussion.status === "running" ? discussionNowText(discussion) : `${done} / ${discussionTotal(discussion)} 段`;
  return (
    <InspRecord
      data-record={key}
      className={here ? "is-here" : undefined}
      title="讨论"
      sub={discussionMeta(discussion)}
      status={discussionStatusLabel(discussion)}
      tone={live ? "live" : discussion.status === "failed" ? "bad" : "plain"}
      open={open}
      onToggle={onToggle}
    >
      <div className="dispute-record">
        <p className="talk-topic">{discussion.topic}</p>
        <section className="dispute-part" aria-label="讨论的每一段">
          <header>
            <b>每一段<i>{count}</i></b>
            {drawer && (
              <InspTool
                label="在左侧读完整记录"
                placement="left"
                aria-pressed={drawer.activeKey === entryKey}
                onClick={() => (drawer.activeKey === entryKey ? drawer.close() : drawer.open(discussionDrawerEntry(source())))}
              >
                <ArrowsOutSimple size={14} aria-hidden="true" />
              </InspTool>
            )}
          </header>
          <DiscussionOverview discussion={discussion} onOpen={drawer ? (seq) => drawer.open(discussionDrawerEntry(source(seq))) : undefined} />
          {discussion.status === "failed" && discussion.note && <p className="dispute-part-gist">{`中止：${discussion.note}`}</p>}
        </section>
      </div>
    </InspRecord>
  );
}
