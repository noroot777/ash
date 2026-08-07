import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Gauge } from "@phosphor-icons/react";
import type { ContextUsage } from "@harness/shared";
import { contextRatio, formatTokens, formatTokensExact, hasContext } from "@harness/shared/usage";
import { useDismissable } from "../lib/useDismissable.ts";
import { placementStyle, usePanelPlacement } from "../lib/usePanelPlacement.ts";

/**
 * 「这条会话离上下文塞满还有多远」的那颗胶囊。
 *
 * **跟旁边的 TokenUsageChip 是两件事，永远分开显示**：那颗是**流水**（这条会话至今一共
 * 烧了多少 token，一路只增，长会话轻松上千万），这颗是**水位**（此刻上下文里装了多少，
 * 会随压缩掉下来）。两者数量级差几十倍，并成一颗必然被读成同一种东西 —— 概念分家的
 * 理由写在 `shared/src/usage.ts`。
 *
 * 三条口径：
 * ① 显示的是**剩余**，因为用户要的是「还能聊多久」而不是「已经用了多少」；
 * ② **没有窗口就不显示百分比**，只显示绝对水位 —— 编一个分母出来比不显示更坏，
 *    「还剩 60%」是拿来做决定的；
 * ③ 窗口是估的（claude CLI 不自报，只能按模型名猜）时胶囊上带个 `~`，浮层里写明白。
 */
export function ContextMeterChip({ context, className }: {
  context?: ContextUsage | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const place = usePanelPlacement(triggerRef, panelRef, {
    minWidth: 224,
    minHeight: 108,
    fallbackHeight: 180,
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

  if (!hasContext(context)) return null;

  const ratio = contextRatio(context);
  const approx = context.windowEstimated ? "~" : "";
  const label = ratio === null
    ? `上下文 ${formatTokens(context.used)}`
    : `上下文剩 ${approx}${Math.round((1 - ratio) * 100)}%`;
  const spoken = ratio === null
    ? `上下文已用 ${formatTokensExact(context.used)} token，窗口未知`
    : `上下文还剩 ${Math.round((1 - ratio) * 100)}%，已用 ${formatTokensExact(context.used)} / `
      + `${formatTokensExact(context.window!)} token${context.windowEstimated ? "（窗口为估算）" : ""}`;
  // 只有两档：进红区才变色。中间再插一档黄色只会让「变色」失去信号价值。
  const tone = ratio !== null && ratio >= 0.85 ? " is-tight" : "";

  const panel = open && (
    <div
      className="token-usage-panel is-cols-1"
      ref={panelRef}
      tabIndex={-1}
      style={placementStyle(place)}
      role="dialog"
      aria-label="上下文水位明细"
    >
      <header>
        <span>上下文</span>
        <span>token</span>
      </header>
      <dl>
        <div>
          <dt>已装入</dt>
          <dd>{formatTokensExact(context.used)}</dd>
        </div>
        {context.window !== null && (
          <>
            <div>
              <dt>窗口{context.windowEstimated ? "（估算）" : ""}</dt>
              <dd>{formatTokensExact(context.window)}</dd>
            </div>
            <div className="is-total">
              <dt>还可装</dt>
              <dd>{formatTokensExact(Math.max(0, context.window - context.used))}</dd>
            </div>
          </>
        )}
      </dl>
      <footer>
        {context.window === null
          ? "这家 CLI 没报窗口大小，也猜不出模型，所以只给绝对值、不给百分比。"
          : context.windowEstimated
            ? "窗口是按模型名估的（这家 CLI 不自报），仅供参考。"
            : "窗口由 CLI 自报。这是最近一次请求带进模型的输入量，压缩后会掉下来。"}
      </footer>
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`token-usage-chip context-meter-chip${tone}${className ? ` ${className}` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${spoken}；点击查看明细`}
        onClick={() => setOpen((current) => !current)}
      >
        <Gauge size={11} weight="fill" aria-hidden="true" />
        {label}
        {ratio !== null && (
          <span className="context-meter-bar" aria-hidden="true">
            <span style={{ width: `${Math.round(ratio * 100)}%` }} />
          </span>
        )}
      </button>
      {panel && createPortal(panel, document.body)}
    </>
  );
}
