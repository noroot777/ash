import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Coins } from "@phosphor-icons/react";
import type { TokenUsage } from "@harness/shared";
import { formatTokens, formatTokensExact, hasUsage, usageTotal } from "@harness/shared/usage";
import { useDismissable } from "../lib/useDismissable.ts";
import { placementStyle, usePanelPlacement } from "../lib/usePanelPlacement.ts";

/**
 * 「这一轮花了多少 token / 这条会话至今累计多少」的那颗胶囊。
 *
 * **位置固定在气泡尾栏**（`MessageFooter`），头部一颗都不放：每条气泡的尾栏有「本轮」，
 * 会话最后一条的尾栏再多「会话」累计和上下文水位，三颗一行。曾经按「是不是会话最后一条」
 * 决定本轮挂头还是挂尾，同一个数在顶和底之间跳，规则还看不见（用户 2026-08-07 报「位置
 * 不正常」，随后拍板三颗一律归底）。
 *
 * 两个数都给的调用方仍然支持（浮层是双列的），只是眼下没人这么用。
 *
 * 口径三条，都不在这里做决定、只负责如实显示：
 * ① 数字是**所有**进出模型的 token（缓存读也算），归一化在 `shared/src/usage.ts`；
 * ② `null` 不等于 0 —— 那家 CLI 不报账、或这轮跑在本功能上线之前，一律不显示；
 * ③ **一颗胶囊只代表一个 agent**（一条会话 = 一个执行器）。同一任务里换过执行器、
 *    或 @ 了别人插一手，各算各的，任何地方都不许把不同 agent 的账加成一个数
 *    —— 单价不同，加起来那个数不代表任何东西（用户 2026-08-07 明确要求分开）。
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
    showSession ? `总 ${formatTokens(usageTotal(session))}` : "",
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

  return (
    <dl>
      {shown.map((row) => (
        <div key={row.label} className={row.label === "合计" ? "is-total" : undefined}>
          <dt>{row.label}</dt>
          {turn && <dd>{formatTokensExact(row.pick(turn))}</dd>}
          {session && <dd>{formatTokensExact(row.pick(session))}</dd>}
        </div>
      ))}
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
