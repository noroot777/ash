import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "@phosphor-icons/react";

export type CopyState = "idle" | "done" | "failed";

const FEEDBACK_MS = 1600;

/**
 * 复制动作的**就地**反馈：点完按钮自己变成「已复制」，一秒多后自己回去。
 *
 * 会话流里的复制按钮拿不到 WorkspaceShell 的 `notify`（气泡组件在 props 链末端，
 * 为一句提示串一路 prop 不划算），而且用户的眼睛此刻就在按钮上——反馈落在按钮上
 * 比飞到屏幕角落的 toast 更容易被看见。剪贴板写失败（权限/非安全上下文）必须同样
 * 显形，否则「点了没动静」和「点了没成功」长得一模一样。
 */
export function useCopyFeedback() {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    const settle = (next: CopyState) => {
      setState(next);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState("idle"), FEEDBACK_MS);
    };
    try {
      const written = navigator.clipboard?.writeText(text);
      if (written) void written.then(() => settle("done"), () => settle("failed"));
      else settle("failed");
    } catch {
      settle("failed");
    }
  }, []);
  return { state, copy };
}

/**
 * 带就地反馈的复制按钮。外观完全交给调用方的 `className`——它出现在气泡头部（只有图标）、
 * 气泡尾栏（图标加文字）、纯文字胶囊三种皮肤里，组件只负责换文案、换图标、挂状态类名。
 */
export function CopyButton({
  value,
  label,
  doneLabel = "已复制",
  failLabel = "复制失败",
  icon = false,
  iconSize = 13,
  className,
  title,
  ariaLabel,
}: {
  /** 点下去写进剪贴板的文本。 */
  value: string;
  /** 常态下按钮里的文字；只有图标的按钮不给。 */
  label?: React.ReactNode;
  /** 复制成功后顶替 `label` 的文字。 */
  doneLabel?: React.ReactNode;
  /** 复制失败后顶替 `label` 的文字。 */
  failLabel?: React.ReactNode;
  /** 要不要在文字前画图标（成功打勾、失败打叉）。 */
  icon?: boolean;
  iconSize?: number;
  className?: string;
  title?: string;
  ariaLabel?: string;
}) {
  const { state, copy } = useCopyFeedback();
  // 只有图标的按钮（气泡头部那颗）宽高是写死的 22×22，反馈只能换图标——把「已复制」三个字
  // 塞进去会把布局撑开。所以没给 label 就一直没有文字。
  const text = !label ? null : state === "done" ? doneLabel : state === "failed" ? failLabel : label;
  const Glyph = state === "done" ? Check : state === "failed" ? X : Copy;
  const classes = ["copy-button", className, state === "done" ? "is-copied" : "", state === "failed" ? "is-copy-failed" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={classes}
      title={title}
      // 只有图标的按钮全靠 aria-label 说话，反馈也得跟着换，不然读屏用户什么都听不到。
      aria-label={state === "idle" ? ariaLabel : state === "done" ? "已复制" : "复制失败"}
      onClick={() => copy(value)}
    >
      {icon && <Glyph size={iconSize} weight={state === "idle" ? "regular" : "bold"} aria-hidden="true" />}
      {text}
    </button>
  );
}
