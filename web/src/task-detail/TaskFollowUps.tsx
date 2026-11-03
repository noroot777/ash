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
 * 按 `Q` 把全部追问弹开、滚到眼前，焦点落在标题上；已经弹开且就在眼前时再按一下收回。
 * 光滚过去、不展开是不够的（用户 2026-11-03：「按 Q 弹不开后续追问」）—— 默认那一条本来
 * 就露着，人停在信息面板上按下去，画面上什么都没变。弹开着、却被翻到了眼前之外的，那一下
 * 是「带我回去」，不收。只有一条或没有时没什么可弹开，只滚过去。
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

  // 快捷键那一下的回调只登记一次，读的是此刻的展开状态，不是登记那一刻的。
  const latest = useRef({ expanded, expandable });
  latest.current = { expanded, expandable };

  useEffect(() => subscribeInspectorSection(FOLLOW_UPS_SECTION_ID, () => {
    const head = headRef.current;
    if (!sectionRef.current || !head) return;
    head.focus({ preventScroll: true });
    const { expanded: open, expandable: canExpand } = latest.current;
    if (canExpand && open && inView(head)) {
      setExpanded(false);
      return;
    }
    if (canExpand) setExpanded(true);
    // 等弹开的那几条画出来再滚，不然量到的还是收着时的高度。
    requestAnimationFrame(() => {
      const section = sectionRef.current;
      const target = headRef.current;
      if (!section || !target) return;
      // 先让整节尽量露出来，再保证标题本身在眼前 —— 落焦点的是标题。只滚整节不够：追问一长、
      // 人又翻到了中段，视口整个落在这一节里面，「nearest」认为它已经可见、一动不动，标题却在上面看不见。
      section.scrollIntoView({ block: "nearest" });
      target.scrollIntoView({ block: "nearest" });
    });
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

/** 标题是否整个落在它所在滚动区（信息面板那一栏）的可视范围里。 */
function inView(element: HTMLElement): boolean {
  const box = element.getBoundingClientRect();
  const scroller = element.closest(".task-inspector-scroll");
  const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  return box.top >= view.top && box.bottom <= view.bottom;
}
