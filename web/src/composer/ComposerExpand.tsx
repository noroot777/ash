import { ArrowsOutSimple } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";

/** 首页那张卡上的「全部选项」：展开成新建面板，草稿和选好的东西都带过去。键位同侧栏的新建任务（C）。 */
export function ComposerExpand({ onExpand }: { onExpand: () => void }) {
  const tip = useHoverTip({ placement: "above" });
  return <>
    <button type="button" className="composer-opt is-icon" aria-label="全部选项" aria-keyshortcuts="C"
      onClick={() => { tip.hide(); onExpand(); }} {...tip.anchorProps}>
      <ArrowsOutSimple size={15} />
    </button>
    <HoverTip at={tip.at}>全部选项<kbd>C</kbd></HoverTip>
  </>;
}
