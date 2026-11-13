import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TokenUsage } from "@ash/shared";
import { formatTokens, formatTokensExact, hasUsage, outputRate, usageTotal } from "@ash/shared/usage";
import { useDismissable } from "../lib/useDismissable.ts";
import { placementStyle, usePanelPlacement } from "../lib/usePanelPlacement.ts";

/**
 * 「这一轮花了多少 token」的那颗胶囊：面上只有一个数，点开是明细。会话累计不显示
 * （用户 2026-11-13）。
 *
 * 住两处：任务会话的回合尾那一排（派生和「更多」之间，跟那一排一起指到才出），团队流
 * 气泡的尾栏。上下文水位那颗（ContextMeterChip）借这颗的外形，两颗并排时长得像一家人。
 *
 * 面上和明细里的数都走 formatTokens：一万以下照写，往上按 k / M / B 收成三四位有效数字
 * ——几千万、几亿的时候写到个位只是一串读不过来的数。精确值留在读屏名里。
 *
 * 口径三条，都不在这里做决定、只负责如实显示：
 * ① 数字是**所有**进出模型的 token（缓存读也算），归一化在 `shared/src/usage.ts`；
 * ② `null` 不等于 0 —— 那家 CLI 不报账、或这轮跑在本功能上线之前，一律不显示；
 * ③ **一颗胶囊只代表一个 agent**（一条会话 = 一个执行器）。同一任务里换过执行器、
 *    或 @ 了别人插一手，各算各的，任何地方都不许把不同 agent 的账加成一个数
 *    —— 单价不同，加起来那个数不代表任何东西（用户 2026-08-07 明确要求分开）。
 */
export function TokenUsageChip({ usage, className }: { usage?: TokenUsage | null; className?: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const place = usePanelPlacement(triggerRef, panelRef, {
    minWidth: 248,
    minHeight: 150,
    fallbackHeight: 210,
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

  if (!hasUsage(usage)) return null;
  const total = usageTotal(usage);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`token-usage-chip${className ? ` ${className}` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`本轮 ${formatTokensExact(total)} token；点击查看明细`}
        onClick={() => setOpen((current) => !current)}
      >
        <b>{formatTokens(total)}</b>
        <span>token</span>
      </button>
      {open && createPortal(
        <div
          className="usage-panel"
          ref={panelRef}
          tabIndex={-1}
          style={placementStyle(place)}
          role="dialog"
          aria-label="本轮 Token 明细"
        >
          <header>
            <span>本轮</span>
            <b>{formatTokens(total)}</b>
          </header>
          <UsageBreakdown usage={usage} total={total} />
        </div>,
        document.body,
      )}
    </>
  );
}

/** 账目的四份，次序固定（先进后出），每一回合拿来比的时候色块不换位置。 */
const PARTS: { key: "input" | "cacheRead" | "cacheWrite" | "output"; label: string }[] = [
  { key: "input", label: "输入" },
  { key: "cacheRead", label: "缓存读" },
  { key: "cacheWrite", label: "缓存写" },
  { key: "output", label: "输出" },
];

/**
 * 一条按占比切开的横条，下面一份一行：数和占比。缓存读按上游报的原样计入总量——它便宜得多，
 * 但确实进了上下文；横条让「这一轮大头是缓存读」一眼看得出，不用再写一句说明。
 * 思考算在输出里，挂在输出下面一行，不进横条；输出速度同样挂在那儿，这一轮没计上时就不出现。
 */
function UsageBreakdown({ usage, total }: { usage: TokenUsage; total: number }) {
  const parts = PARTS.filter((part) => usage[part.key] > 0);
  const rate = outputRate(usage);
  const share = (n: number) => {
    const pct = (n / total) * 100;
    return pct >= 1 ? `${Math.round(pct)}%` : "<1%";
  };
  return (
    <>
      <div className="usage-bar" aria-hidden="true">
        {parts.map((part) => <span key={part.key} className={`is-${part.key}`} style={{ flexGrow: usage[part.key] }} />)}
      </div>
      <dl>
        {parts.map((part) => (
          <div key={part.key} aria-label={`${part.label} ${formatTokensExact(usage[part.key])} token`}>
            <dt><i className={`is-${part.key}`} aria-hidden="true" />{part.label}</dt>
            <dd>{formatTokens(usage[part.key])}</dd>
            <dd>{share(usage[part.key])}</dd>
          </div>
        ))}
        {usage.reasoning > 0 && (
          <div className="is-sub">
            <dt>其中思考</dt>
            <dd>{formatTokens(usage.reasoning)}</dd>
            <dd />
          </div>
        )}
        {rate !== null && (
          <div className="is-sub" aria-label={`输出速度每秒 ${formatRate(rate)} token`}>
            <dt>速度</dt>
            <dd>{formatRate(rate)}/s</dd>
            <dd />
          </div>
        )}
      </dl>
    </>
  );
}

/** 慢到个位数时留一位小数,不然 0.4 会写成 0,读着像「没在出字」。 */
const formatRate = (rate: number) => (rate < 10 ? rate.toFixed(1) : String(Math.round(rate)));
