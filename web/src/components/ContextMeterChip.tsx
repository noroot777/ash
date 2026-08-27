import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Gauge } from "@phosphor-icons/react";
import type { ContextUsage, Session } from "@ash/shared";
import { contextRatio, effectiveContextWindow, formatTokens, formatTokensExact, hasContext } from "@ash/shared/usage";
import { useDismissable } from "../lib/useDismissable.ts";
import { placementStyle, usePanelPlacement } from "../lib/usePanelPlacement.ts";
import { ContextCompactQuickSettings } from "./ContextCompactQuickSettings.tsx";

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
 * ③ 执行器配了自动压缩窗口时优先用它算剩余量；模型能力上限仍保留在明细里。没配时
 *    才用 CLI 自报值，自报缺失又只能按模型名猜时胶囊上带个 `~`。
 *
 * 明细下面挂着**快捷设置**（`ContextCompactQuickSettings`）：面板里这几个数从哪来，
 * 就在同一个面板里改得动。给了 `session` 才有，因为要知道改的是哪个执行器 profile。
 */
export function ContextMeterChip({ context, session, className }: {
  context?: ContextUsage | null;
  /** 这条会话的身份 —— 快捷设置要靠它定位执行器 profile。不给就只有只读明细。 */
  session?: Session | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const place = usePanelPlacement(triggerRef, panelRef, {
    // 展开设置后面板里是一排输入框，224px 塞不下；收起时仍按明细的窄宽度走。
    minWidth: editing ? 296 : 224,
    minHeight: 108,
    fallbackHeight: 180,
    enabled: open,
  });

  const close = () => {
    setOpen(false);
    setEditing(false);
  };

  useDismissable({
    enabled: open,
    containerRef: panelRef,
    onClose: close,
    restoreFocusRef: triggerRef,
  });

  useLayoutEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!hasContext(context)) return null;

  const window = effectiveContextWindow(context);
  const usesCompactWindow = typeof context.compactWindow === "number"
    && Number.isFinite(context.compactWindow)
    && context.compactWindow > 0;
  const displayWindowEstimated = !usesCompactWindow && context.windowEstimated;
  const ratio = contextRatio(context);
  const approx = displayWindowEstimated ? "~" : "";
  const label = ratio === null
    ? `上下文 ${formatTokens(context.used)}`
    : `上下文剩 ${approx}${Math.round((1 - ratio) * 100)}%`;
  const spoken = ratio === null
    ? `上下文已用 ${formatTokensExact(context.used)} token，窗口未知`
    : `上下文还剩 ${Math.round((1 - ratio) * 100)}%，已用 ${formatTokensExact(context.used)} / `
      + `${formatTokensExact(window!)} token${displayWindowEstimated ? "（窗口为估算）" : ""}`;
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
        {window !== null && (
          <>
            <div>
              <dt>{usesCompactWindow ? "压缩窗口" : `窗口${displayWindowEstimated ? "（估算）" : ""}`}</dt>
              <dd>{formatTokensExact(window)}</dd>
            </div>
            {usesCompactWindow && context.window !== null && context.window !== window && (
              <div>
                <dt>模型上限</dt>
                <dd>{formatTokensExact(context.window)}</dd>
              </div>
            )}
            <div className="is-total">
              <dt>{usesCompactWindow ? "距压缩" : "还可装"}</dt>
              <dd>{formatTokensExact(Math.max(0, window - context.used))}</dd>
            </div>
          </>
        )}
      </dl>
      <footer>
        {window === null
          ? "这家 CLI 没报窗口大小，也猜不出模型，所以只给绝对值、不给百分比。"
          : usesCompactWindow
            ? "窗口采用执行器的自动压缩设置；到达这里会开始压缩，不代表模型能力上限只有这么大。"
          : displayWindowEstimated
            ? "这一轮没拿到 CLI 自报的窗口，只能按模型名估，仅供参考。"
            : "窗口由 CLI 自报。这是最近一次请求带进模型的输入量，压缩后会掉下来。"}
      </footer>
      {session && (
        <ContextCompactQuickSettings
          session={session}
          open={editing}
          onToggle={() => setEditing((current) => !current)}
        />
      )}
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
        onClick={() => (open ? close() : setOpen(true))}
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
