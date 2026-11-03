import { useEffect, useRef } from "react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { subscribeInspectorSection, type InspectorSection } from "../inspector/sections.ts";
import { inspectorShortcutLabel, type InspectorShortcutKey } from "../inspector/shortcuts.ts";
import { InspectorPromptContent } from "./InspectorPromptContent.tsx";
import { formatInstant } from "./utils.ts";

export type TaskFollowUp = { text: string; attachments: string[]; at?: string };

/** 信息面板里「后续追问」那一节的直达键 `I Q`（q = follow-up questions）。 */
export const FOLLOW_UPS_SECTION = { id: "follow-ups", shortcut: "q" } as const satisfies InspectorSection<InspectorShortcutKey>;

/**
 * 默认收着（原始需求才是第一眼要看的），按 `I Q` 直达：展开、滚到眼前、焦点落在标题上 ——
 * 落焦点是为了接着用键盘：回车/空格就能收回去，不用再摸鼠标。
 *
 * 只管「打开」不管「收起」，跟 `I …` 那一族别的键一样是「去那儿」而不是开关：连按两下
 * 不会把刚翻出来的东西又合上。展开状态仍归 `<details>` 自己，这里只在快捷键那一下写一次。
 */
export function TaskFollowUps({ followUps }: { followUps: TaskFollowUp[] }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const tip = useHoverTip({ placement: "above" });

  useEffect(() => subscribeInspectorSection(FOLLOW_UPS_SECTION.id, () => {
    const details = detailsRef.current;
    if (!details) return;
    details.open = true;
    summaryRef.current?.focus({ preventScroll: true });
    details.scrollIntoView({ block: "nearest" });
  }), []);

  return (
    <details ref={detailsRef} className="task-inspector-follow-ups">
      {/* 提示只跟鼠标走：快捷键那一下会把焦点送到这里，跟着焦点弹提示就成了按完键还要看一句废话。 */}
      <summary ref={summaryRef} onMouseEnter={tip.anchorProps.onMouseEnter} onMouseLeave={tip.hide}>后续追问</summary>
      <HoverTip at={tip.at}><kbd>{inspectorShortcutLabel(FOLLOW_UPS_SECTION.shortcut)}</kbd></HoverTip>
      {followUps.length ? (
        <ol>
          {followUps.map((followUp, index) => (
            <li key={`${followUp.at ?? "pending"}:${index}`}>
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
    </details>
  );
}
