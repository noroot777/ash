import { useId, useState, type ReactNode } from "react";
import type { TaskListItem } from "@ash/shared";
import { FileText, ListBullets, Trash } from "@phosphor-icons/react";
import { useLeftDrawer } from "../components/LeftDrawer.tsx";
import { DiscussionOverview, discussionDrawerEntry, type DiscussionDrawerSource } from "../free-workflow/DiscussionRecord.tsx";
import { discussionBubbleText, discussionLive, discussionMeta, discussionNowText } from "../free-workflow/discussionModel.ts";
import { BubbleKey, BubbleShell } from "./BubbleShell.tsx";
import type { ConversationDiscussionRow } from "./conversationDiscussionRows.ts";
import { useMessageDelete } from "./MessageDelete.tsx";
import { durationBetween, formatInstant } from "./utils.ts";

/**
 * 一整场讨论在会话里的那一颗气泡：靠右、一圈细边，跟辩论那颗是同一副骨架（BubbleShell），点法也照它。位置在你
 * 发起讨论时写的那一句后面，一场一颗。
 *
 * 写什么见 `discussionBubbleText`：还在说时写刚说完那一段的一句话（最多两行，原地换字，气泡不往下长），下面靠右
 * 一行小灰字是此刻谁在说第几段；说完了写谈了几段、谈拢没谈拢；中途断了如实写断在哪、为什么（刷新后照样在）。
 *
 * 点法：
 * - 还在说（连同写合稿那一下）：点气泡 = 在下面就地摊开每段一行；浮出的那一行只有文档键；
 * - 说完以后：点气泡 = 右侧「审议」格里打开这一场（`onOpen`；没有那一格时不给，退回就地摊开）；浮出那一行
 *   几颗图标键：文档 = 左侧抽屉读完整记录；列表 = 在气泡下面就地摊开；删除 = 连同发起那一句、合稿删掉整场
 *   （能删时才有，跟发起那一句上的删除是同一个动作）。
 */
export function DiscussionBubble({ row, fallback, task, onOpen }: {
  row: ConversationDiscussionRow;
  fallback: ReactNode;
  task: Pick<TaskListItem, "id">;
  onOpen?: (discussionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const drawer = useLeftDrawer();
  const discussion = row.discussion;
  const remove = useMessageDelete({ discussionId: discussion && !discussionLive(discussion) ? discussion.id : undefined });
  const said = discussion ? discussionBubbleText(discussion) : { lead: null, text: "讨论" };
  const [shown, setShown] = useState(said.text);
  const [swapped, setSwapped] = useState(false);
  if (said.text !== shown) {
    setShown(said.text);
    setSwapped(true);
  }
  const toggle = () => setOpen((value) => !value);
  if (!discussion) {
    return (
      <BubbleShell className="debate-bubble discussion-bubble is-settled" name="讨论" meta={formatInstant(row.startedAt)}
        below={open && <div className="turn-footnote-lane" id={bodyId}>{fallback}</div>}>
        <button type="button" className="review-verdict-text" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>讨论</button>
      </BubbleShell>
    );
  }
  const live = discussionLive(discussion);
  const state = live ? "live" : discussion.status === "failed" ? "failed" : "settled";
  const source = (seq?: number): DiscussionDrawerSource => ({ task, discussionId: discussion.id, seq, discussions: [discussion] });
  const entryKey = discussionDrawerEntry(source()).key;
  const openRecord = (seq?: number) => drawer?.open(discussionDrawerEntry(source(seq)));
  const goPanel = !live && onOpen ? () => onOpen(discussion.id) : null;
  const took = live ? null : durationBetween(discussion.startedAt, discussion.finishedAt);
  const meta = [discussionMeta(discussion), took, formatInstant(discussion.startedAt)].filter(Boolean).join(" · ");
  return (
    <BubbleShell
      className={`debate-bubble discussion-bubble is-${state}${live ? " is-pending" : ""}`}
      name="讨论"
      meta={meta}
      keys={<>
        {drawer && (
          <BubbleKey label="讨论的完整记录" pressed={drawer.activeKey === entryKey}
            onClick={() => (drawer.activeKey === entryKey ? drawer.close() : openRecord())}>
            <FileText size={14} aria-hidden="true" />
          </BubbleKey>
        )}
        {!live && <BubbleKey label="每段一句" expanded={open} controls={bodyId} onClick={toggle}><ListBullets size={14} aria-hidden="true" /></BubbleKey>}
        {remove.available && <BubbleKey label="删除这场讨论" onClick={remove.request}><Trash size={14} aria-hidden="true" /></BubbleKey>}
        {remove.dialog}
      </>}
      below={<>
        {/* 谁在说第几段：展开前后都紧贴在气泡下面。 */}
        {live && <p className="review-progress-now"><span className="review-progress-step">{discussionNowText(discussion)}</span></p>}
        {open && (
          <div className="turn-footnote-lane debate-bubble-lane" id={bodyId}>
            <DiscussionOverview discussion={discussion} onOpen={drawer ? openRecord : undefined} />
          </div>
        )}
      </>}
    >
      <button
        type="button"
        className="review-verdict-text"
        aria-label={`讨论：${said.lead ? `${said.lead}，` : ""}${said.text}${goPanel ? "，在右侧审议格里打开这场讨论" : ""}`}
        aria-expanded={goPanel ? undefined : open}
        aria-controls={goPanel ? undefined : bodyId}
        onClick={() => (goPanel ? goPanel() : toggle())}
      >
        {live && <span className="workspace-status-dot workspace-status-dot--run review-progress-dot" aria-hidden="true" />}
        <span key={said.text} className={`debate-bubble-say${swapped ? " is-fresh" : ""}`} data-selection-content="">
          {said.lead && <b>{said.lead}</b>}{said.text}
        </span>
      </button>
    </BubbleShell>
  );
}
