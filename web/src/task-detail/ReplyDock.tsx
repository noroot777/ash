import { useId, type ReactNode } from "react";
import { SpinnerGap } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";

/**
 * 回复框顶上那一行的骨架：几颗纯文字的切换键，点一颗回复框就变成那一步，发送键写着这一按的名字。
 *
 * 两处在用、长得一样、在同一个位置：等你裁定时的几种下一步（free-workflow/DisputeRulingDock.tsx），
 * 和 `@` 了一个人之后它来做什么（ReplyCallDock.tsx）。同一时刻框顶只有一行，谁让谁见 ReplyBox。
 */
export type DockChoice<T extends string> = {
  id: T;
  label: string;
  /** 它会发生什么：指到（键盘走到）才浮出来。 */
  tip: string;
  /** 此刻按不动的原因；null = 能按。按不动时仍然指得到、走得进来，原因就是浮出来的那一句。 */
  held?: string | null;
};

function DockKey<T extends string>({ choice, pressed, onPick }: { choice: DockChoice<T>; pressed: boolean; onPick: () => void }) {
  const tip = useHoverTip({ placement: "above" });
  const tipId = useId();
  const text = choice.held ?? choice.tip;
  return (
    <>
      <button
        type="button"
        className="reply-dock-key"
        aria-pressed={pressed}
        aria-disabled={choice.held ? true : undefined}
        aria-describedby={tipId}
        onClick={() => { if (!choice.held) onPick(); }}
        {...tip.anchorProps}
      >{choice.label}</button>
      <span id={tipId} hidden>{text}</span>
      <HoverTip at={tip.at}>{text}</HoverTip>
    </>
  );
}

export function ReplyDockRow<T extends string>({ label, choices, pressed, onPick, onEscape, error, errorAction, children }: {
  /** 这一组的读屏名（「怎么裁定这条驳回」「叫 codex 来做什么」）。 */
  label: string;
  choices: readonly DockChoice<T>[];
  pressed: T | null;
  onPick: (choice: T) => void;
  /** 焦点在这一行里时按 Esc。 */
  onEscape?: () => void;
  error?: string | null;
  /** 跟在那句错误后面的一颗键（「重试」）。 */
  errorAction?: { label: string; onClick: () => void } | null;
  /** 这一行里不归切换键的东西（登记「画出来了」之类，不占位置）。 */
  children?: ReactNode;
}) {
  return (
    <div className="reply-dock" onKeyDown={(event) => {
      if (event.key === "Escape" && onEscape) { event.preventDefault(); onEscape(); }
    }}>
      {children}
      <div className="reply-dock-row" role="group" aria-label={label}>
        {choices.map((choice) => (
          <DockKey key={choice.id} choice={choice} pressed={choice.id === pressed} onPick={() => onPick(choice.id)} />
        ))}
      </div>
      {error && (
        <p className="reply-dock-error" role="alert">
          {error}
          {errorAction && <button type="button" className="reply-dock-error-action" onClick={errorAction.onClick}>{errorAction.label}</button>}
        </p>
      )}
    </div>
  );
}

/** 顶替发送键的那颗：实心、写着这一按的名字。 */
export function ReplyDockSend({ label, busy = false, disabled = false, reason, onSend }: {
  label: string;
  busy?: boolean;
  disabled?: boolean;
  /** 按不动的原因（「先写点内容」），进读屏的描述。 */
  reason?: string | null;
  onSend: () => void;
}) {
  const reasonId = useId();
  return (
    <>
      <button type="button" className="reply-dock-send" disabled={busy || disabled} aria-busy={busy || undefined}
        aria-describedby={reason ? reasonId : undefined} onClick={onSend}>
        {busy && <SpinnerGap size={13} className="is-spinning" aria-hidden="true" />}
        {label}
      </button>
      {reason && <span id={reasonId} hidden>{reason}</span>}
    </>
  );
}
