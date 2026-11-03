import { useEffect, useMemo, useRef, useState } from "react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { subscribeInspectorSection } from "../inspector/sections.ts";
import { FOLLOW_UPS_SECTION_ID, FOLLOW_UPS_SHORTCUT } from "./followUpsSection.ts";
import { InspectorPromptContent } from "./InspectorPromptContent.tsx";
import { formatInstant } from "./utils.ts";

export type TaskFollowUp = { text: string; attachments: string[]; at?: string };

/**
 * 默认只露最新一条（用户 2026-11-03：要看的几乎总是「我刚才又说了什么」），＋ 展开全部。
 * 展开后**新的在上**：最新那条原地不动，更早的接在它下面 —— 按时间正排的话，一展开它就被
 * 挤到最底下，刚看着的东西换了位置。只有一条或没有时没什么可展开，那颗 ＋ 也就不出现。
 *
 * 按 `Q` 直达：滚到眼前、焦点落在标题上（回车/空格就能展开收起，不用再摸鼠标）。它只管
 * 「去那儿」，不动展开状态 —— 连按两下不会把刚展开的又合上。
 */
export function TaskFollowUps({ followUps }: { followUps: TaskFollowUp[] }) {
  const [expanded, setExpanded] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const tip = useHoverTip({ placement: "above" });
  const newestFirst = useMemo(
    () => followUps.map((followUp, index) => ({ followUp, index })).reverse(),
    [followUps],
  );
  const expandable = newestFirst.length > 1;
  const shown = expanded ? newestFirst : newestFirst.slice(0, 1);

  useEffect(() => subscribeInspectorSection(FOLLOW_UPS_SECTION_ID, () => {
    const section = sectionRef.current;
    const head = headRef.current;
    if (!section || !head) return;
    head.focus({ preventScroll: true });
    // 先让整节尽量露出来，再保证标题本身在眼前 —— 落焦点的是标题。只滚整节不够：追问一长、
    // 人又翻到了中段，视口整个落在这一节里面，「nearest」认为它已经可见、一动不动，标题却在上面看不见。
    section.scrollIntoView({ block: "nearest" });
    head.scrollIntoView({ block: "nearest" });
  }), []);

  // 提示只跟鼠标走：快捷键那一下会把焦点送到标题上，跟着焦点弹提示就成了按完键还要看一句废话。
  const headTip = { onMouseEnter: tip.anchorProps.onMouseEnter, onMouseLeave: tip.hide };
  return (
    <div ref={sectionRef} className="task-inspector-follow-ups">
      {expandable ? (
        <button
          ref={(node) => { headRef.current = node; }}
          type="button"
          className="task-inspector-follow-ups-head"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          {...headTip}
        >
          后续追问
        </button>
      ) : (
        <h3 ref={(node) => { headRef.current = node; }} className="task-inspector-follow-ups-head" tabIndex={-1} {...headTip}>
          后续追问
        </h3>
      )}
      <HoverTip at={tip.at}><kbd>{FOLLOW_UPS_SHORTCUT.toUpperCase()}</kbd></HoverTip>
      {shown.length ? (
        <ol>
          {shown.map(({ followUp, index }) => (
            <li key={index}>
              {followUp.at && <time dateTime={followUp.at}>{formatInstant(followUp.at)}</time>}
              <InspectorPromptContent
                text={followUp.text}
                attachments={followUp.attachments}
                emptyText="（空消息）"
              />
            </li>
          ))}
        </ol>
      ) : <p className="task-inspector-note">暂无后续追问。</p>}
    </div>
  );
}
