import type { HandoffPeerOffline } from "@ash/shared";
import { ArrowClockwise, SpinnerGap } from "@phosphor-icons/react";

/** 出站行的状态说明所需的一切。整块传，免得四层组件各自摊平成五个 prop。 */
export type OutboundBar = {
  outboundCount: number;
  offlinePeers: HandoffPeerOffline[];
  asked: boolean;
  refreshing: boolean;
  onRefresh: () => void;
};

// 出站行那条状态说明。
//
// 接力出去的任务，本机存的是**交出去那一刻**的状态；真状态在持有机那边。原来每 20 秒
// 自动跨机器问一轮，现在改成用户按（理由见 useOutboundState.ts 顶部）。改完就必须把
// 「你看到的不是实时状态」这句话摆在明处 —— 不说的话，一批冻住的旧状态混在最该可信的
// 那个列表里，比不显示更糟。
//
// 三种话分开说，因为用户要做的事不一样：
//   · 还没问过 → 「显示的是接力当时的状态」，给一个问的入口
//   · 问过、有机器联系不上 → 说清是哪几台，给重试
//   · 问过、都通了 → 只留一个不打眼的重新问入口
export function OutboundStatusBar({
  outboundCount,
  offlinePeers,
  asked,
  refreshing,
  onRefresh,
}: OutboundBar) {
  if (!outboundCount) return null;
  const offlineNames = offlinePeers.map((peer) => peer.name).join("、");
  const label = refreshing
    ? "正在问持有机…"
    : offlinePeers.length
      ? `联系不上 ${offlineNames}，这些机器上的任务显示的是接力当时的状态`
      : asked
        ? `${outboundCount} 个接力出去的任务，状态问过了`
        : `${outboundCount} 个接力出去的任务显示的是接力当时的状态`;
  return (
    <p className="workspace-task-offline-peers" role="status">
      {label}
      <button
        className="workspace-task-outbound-refresh"
        type="button"
        disabled={refreshing}
        onClick={onRefresh}
      >
        {refreshing
          ? <SpinnerGap size={11} className="is-spinning" aria-hidden="true" />
          : <ArrowClockwise size={11} aria-hidden="true" />}
        {offlinePeers.length || asked ? "重新问一次" : "问一次持有机"}
      </button>
    </p>
  );
}
