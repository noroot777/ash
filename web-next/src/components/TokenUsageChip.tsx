import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Coins } from "@phosphor-icons/react";
import type { TokenUsage } from "@harness/shared";
import { formatCost, formatTokens, formatTokensExact, hasUsage, usageTotal } from "@harness/shared/usage";
import { useDismissable } from "../lib/useDismissable.ts";
import { placementStyle, usePanelPlacement } from "../lib/usePanelPlacement.ts";

/**
 * 「这一轮花了多少 token / 这条会话至今累计多少」的那颗胶囊。
 *
 * 胶囊上只放一眼能扫的两个数（本轮 · 会话），明细（输入/缓存/输出/费用）藏在浮层里：
 * 会话尾巴那一行已经挤着会话 id 和 resume 命令，再铺开四五个数就没人看了。
 *
 * 口径三条，都不在这里做决定、只负责如实显示：
 * ① 数字是**所有**进出模型的 token（缓存读也算），归一化在 `shared/src/usage.ts`；
 * ② `null` 不等于 0 —— 那家 CLI 不报账、或这轮跑在本功能上线之前，一律不显示；
 * ③ 费用只有 claude 报，codex 那边是 null，所以明细里那一行会缺席而不是写 $0。
 */
export function TokenUsageChip({
  turn,
  session,
  className,
}: {
  /** 这一回合的用量。 */
  turn?: TokenUsage | null;
  /** 整条会话至今的累计用量。 */
  session?: TokenUsage | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const place = usePanelPlacement(triggerRef, panelRef, {
    minWidth: 232,
    minHeight: 120,
    fallbackHeight: 200,
    enabled: open,
  });

  useDismissable({
    enabled: open,
    containerRef: panelRef,
    onClose: () => setOpen(false),
    restoreFocusRef: triggerRef,
  });

  useLayoutEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const showTurn = hasUsage(turn);
  const showSession = hasUsage(session);
  if (!showTurn && !showSession) return null;

  const parts = [
    showTurn ? `本轮 ${formatTokens(usageTotal(turn))}` : "",
    showSession ? `会话 ${formatTokens(usageTotal(session))}` : "",
  ].filter(Boolean);
  const spoken = [
    showTurn ? `本轮 ${formatTokensExact(usageTotal(turn))} token` : "",
    showSession ? `本会话累计 ${formatTokensExact(usageTotal(session))} token` : "",
  ].filter(Boolean).join("，");

  const panel = open && (
    <div
      className={`token-usage-panel is-cols-${showTurn && showSession ? 2 : 1}`}
      ref={panelRef}
      tabIndex={-1}
      style={placementStyle(place)}
      role="dialog"
      aria-label="Token 用量明细"
    >
      <header>
        <span>Token 用量</span>
        {showTurn && <span>本轮</span>}
        {showSession && <span>会话</span>}
      </header>
      <UsageRows turn={showTurn ? turn : null} session={showSession ? session : null} />
      <footer>缓存读按上游报的原样计入总量；它便宜得多，但确实进了上下文。</footer>
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`token-usage-chip${className ? ` ${className}` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${spoken}；点击查看明细`}
        onClick={() => setOpen((current) => !current)}
      >
        <Coins size={11} weight="fill" aria-hidden="true" />
        {parts.join(" · ")}
      </button>
      {panel && createPortal(panel, document.body)}
    </>
  );
}

function UsageRows({ turn, session }: { turn: TokenUsage | null; session: TokenUsage | null }) {
  const rows: { label: string; pick: (u: TokenUsage) => number }[] = [
    { label: "输入", pick: (u) => u.input },
    { label: "缓存读", pick: (u) => u.cacheRead },
    { label: "缓存写", pick: (u) => u.cacheWrite },
    { label: "输出", pick: (u) => u.output },
    { label: "其中思考", pick: (u) => u.reasoning },
    { label: "合计", pick: usageTotal },
  ];
  const shown = rows.filter((row) =>
    (turn ? row.pick(turn) : 0) > 0 || (session ? row.pick(session) : 0) > 0);
  const cost = [turn, session].map((u) => (u ? formatCost(u.costUsd) : null));

  return (
    <dl>
      {shown.map((row) => (
        <div key={row.label} className={row.label === "合计" ? "is-total" : undefined}>
          <dt>{row.label}</dt>
          {turn && <dd>{formatTokensExact(row.pick(turn))}</dd>}
          {session && <dd>{formatTokensExact(row.pick(session))}</dd>}
        </div>
      ))}
      {(cost[0] || cost[1]) && (
        <div className="is-cost">
          <dt>费用</dt>
          {turn && <dd>{cost[0] ?? "—"}</dd>}
          {session && <dd>{cost[1] ?? "—"}</dd>}
        </div>
      )}
      {!!session?.turns && (
        <div className="is-turns">
          <dt>回合数</dt>
          {turn && <dd>1</dd>}
          <dd>{session.turns}</dd>
        </div>
      )}
    </dl>
  );
}
