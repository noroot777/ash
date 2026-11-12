// 全应用共用的那颗发送键：左边一个箭头（主段），右边连着一条小尖角，尖角点开是「发送设置」
// （回复框：立即 / 指定时间 / 等任务完成）或「启动设置」（新建任务：五档）。
//
// 这颗键**不自己判断**能不能发、该写什么字：状态机在调用方手里（回复框知道任务在不在跑、
// 有没有在传附件、定时选好了没；新建面板知道执行器、排队目标、门禁），这里只把那几样
// 画成同一副长相——所以全部视觉状态都是 props：
//   · 立即：只画箭头，「做什么 + 快捷键」在悬停提示里；
//   · 发不出去（`blocked`，空输入也算）：键还是实心的，只有箭头和字变淡；指上去说为什么；
//     尖角照样点得动；
//   · 不是马上发（`text`：排队发送 / 定时发送 / 完成后发送 / 上传中 37%）：键变宽写字，
//     尖角换成时钟或沙漏（`settings.glyph`）；
//   · 停止（`stop`）：任务在跑、输入框空着时主段就是停止键；
//   · 排队发送时左边多一颗小停止键（`halt`）——任何时候都停得下来；
//   · 在途（`busy`）：箭头换成转圈，不响应。
// 回车走调用方自己的提交函数，提交函数里必须再判一次门禁（web/CLAUDE.md「主工作区」），
// 这颗键的 `blocked` 只管点击和长相。
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, CaretDown, Clock, HourglassMedium, SpinnerGap, Stop } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "./HoverTip.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import { useSendKeyLabels } from "../lib/useComposerSendKey.ts";
import "./send-key.css";

/** 尖角上画什么：平时一个小尖角，定时是时钟，等别的事（排队、等任务完成、上传）是沙漏。 */
export type SendKeyGlyph = "caret" | "clock" | "sand";

export type SendKeyStop = {
  /** 提示里那一句（「停止这一轮」「不排了」）。 */
  tip: string;
  onStop: () => void;
  disabled?: boolean;
  /** 读屏名，缺省「停止」。 */
  label?: string;
};

export type SendKeySettings = {
  /** 「发送设置」/「启动设置」。尖角的读屏名是「名字：当前档」。 */
  label: string;
  /** 当前那一档的名字（立即发送 / 指定时间 / 创建并排队…）。 */
  value?: string;
  glyph?: SendKeyGlyph;
  disabled?: boolean;
  /** 浮层里的内容；函数形式拿到 close（选完要收起时用）。 */
  children: ReactNode | ((close: () => void) => ReactNode);
  className?: string;
};

export type SendKeyProps = {
  /** 立即那一档做的事：「发送」「创建并运行」。没有字时它就是读屏名，也是提示里那一句。 */
  action: string;
  /** 不是马上发时键上写的字；空 = 只画箭头。 */
  text?: string | null;
  /** 能发时提示里的那一句，缺省是键上的字或 action（例如「11/12 16:00 自动发出」）。 */
  tip?: string | null;
  /** 发不出去的原因。非空时箭头和字变淡、点了不发，提示写这句。 */
  blocked?: string | null;
  busy?: boolean;
  stop?: SendKeyStop | null;
  halt?: SendKeyStop | null;
  /** 提示里的键名。缺省跟「发送键」设置走；传 null 不写。 */
  shortcut?: string | null;
  /** sm = 29px（回复框），md = 36px（新建卡片）。 */
  size?: "sm" | "md";
  onSend: () => void;
  settings: SendKeySettings;
  className?: string;
};

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

export function SendKey({ action, text, tip, blocked, busy = false, stop, halt, shortcut, size = "sm", onSend, settings, className = "" }: SendKeyProps) {
  const keys = useSendKeyLabels();
  const mainTip = useHoverTip({ placement: "above" });
  const optTip = useHoverTip({ placement: "above" });
  const haltTip = useHoverTip({ placement: "above" });
  const describe = useId();
  const root = useRef<HTMLSpanElement>(null);
  const main = useRef<HTMLButtonElement>(null);
  const clip = useRef<HTMLElement>(null);
  const opt = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const stopping = !!stop;
  const label = stopping ? "" : text?.trim() || "";
  const dim = !stopping && (!!blocked || busy);
  const key = shortcut === undefined ? keys.sendShort : shortcut;
  const say = stopping ? stop!.tip : blocked || tip || label || action;
  const sendable = !stopping && !dim;

  // 键变宽变窄：布局一步到位，再让底色的左缘、箭头、尖角和同一排的邻居从旧位置滑到新位置
  // （只动 transform）。旧位置在渲染这一刻量——这时 DOM 还是上一帧的样子。
  const face = `${label}|${stopping}|${!!halt}`;
  const lastFace = useRef(face);
  const before = useRef<{ main: DOMRect; others: [Element, DOMRect][] } | null>(null);
  if (face !== lastFace.current && main.current && root.current?.parentElement && !reduced()) {
    const others = [...root.current.parentElement.children].filter((node) => node !== root.current);
    before.current = { main: main.current.getBoundingClientRect(), others: [...others, opt.current!].filter(Boolean).map((node) => [node, node.getBoundingClientRect()]) };
  }
  useLayoutEffect(() => {
    lastFace.current = face;
    const was = before.current;
    before.current = null;
    if (!was || !main.current || !clip.current) return;
    const now = main.current.getBoundingClientRect();
    const slide = (node: Element, dx: number) => {
      if (Math.abs(dx) > 0.5) node.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: 200, easing: EASE });
    };
    const right = was.main.right - now.right;
    slide(clip.current, right);
    if (clip.current.firstElementChild) slide(clip.current.firstElementChild, was.main.left - now.left - right);
    for (const [node, rect] of was.others) slide(node, rect.left - node.getBoundingClientRect().left);
  }, [face]);

  const close = () => setOpen(false);
  useEffect(() => { if (settings.disabled) setOpen(false); }, [settings.disabled]);
  const glyph = settings.glyph ?? "caret";
  const named = settings.value ? `${settings.label}：${settings.value}` : settings.label;

  return (
    <span ref={root} className={`send-key${size === "md" ? " is-md" : ""}${dim ? " is-dim" : ""} ${className}`.trim()}>
      {halt && <button type="button" className="send-key-halt" aria-label={halt.label ?? "停止"} disabled={halt.disabled}
        onClick={halt.onStop} {...haltTip.anchorProps}><Stop size={14} weight="fill" /></button>}
      <button ref={main} type="button" className={`send-key-main${label ? " has-text" : ""}`}
        aria-label={stopping ? stop!.label ?? "停止" : label || action}
        aria-disabled={stopping ? stop!.disabled || undefined : dim || undefined}
        aria-busy={busy || undefined}
        aria-describedby={blocked && !stopping ? describe : undefined}
        aria-keyshortcuts={sendable && shortcut === undefined ? keys.ariaShortcut : undefined}
        onClick={() => {
          if (stopping) { if (!stop!.disabled) stop!.onStop(); return; }
          if (!dim) onSend();
        }} {...mainTip.anchorProps}>
        <i ref={clip} className="send-key-clip" aria-hidden="true"><i className="send-key-bg" /></i>
        {label && <span key={label.replace(/[\d.%]/g, "")} className="send-key-text num">{label}</span>}
        <span className="send-key-glyph" aria-hidden="true">
          <ArrowUp size={16} weight="bold" className={!stopping && !busy ? "is-on" : ""} />
          <Stop size={14} weight="fill" className={stopping ? "is-on" : ""} />
          <SpinnerGap size={16} className={busy && !stopping ? "is-on is-spinning" : ""} />
        </span>
      </button>
      <button ref={opt} type="button" className={`send-key-opt ${settings.className ?? ""}`.trim()} aria-label={named}
        aria-haspopup="dialog" aria-expanded={open} disabled={settings.disabled}
        onClick={() => { optTip.hide(); setOpen((value) => !value); }} {...optTip.anchorProps}>
        <span className="send-key-glyph" aria-hidden="true">
          <CaretDown size={12} weight="bold" className={glyph === "caret" ? "is-on" : ""} />
          <Clock size={13} className={glyph === "clock" ? "is-on" : ""} />
          <HourglassMedium size={13} className={glyph === "sand" ? "is-on" : ""} />
        </span>
      </button>
      {blocked && !stopping && <span id={describe} hidden>{blocked}</span>}
      {!open && <HoverTip at={mainTip.at}>{say}{sendable && key && <kbd>{key}</kbd>}</HoverTip>}
      {!open && <HoverTip at={optTip.at}>{named}</HoverTip>}
      {halt && <HoverTip at={haltTip.at}>{halt.tip}</HoverTip>}
      {open && <SendKeyPanel anchor={opt} label={settings.label} onClose={close}>
        {typeof settings.children === "function" ? settings.children(() => { close(); opt.current?.focus(); }) : settings.children}
      </SendKeyPanel>}
    </span>
  );
}

/** 尖角点开的那一层：开在键的上方、右缘对齐尖角；上面放不下才落到下面。贴住下缘，
 *  换档时内容变高只往上长，不压到键。 */
function SendKeyPanel({ anchor, label, onClose, children }: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ right: number; top?: number; bottom?: number } | null>(null);
  useDismissable({ enabled: true, containerRef: panel, restoreFocusRef: anchor, onClose });
  useLayoutEffect(() => {
    const measure = () => {
      if (!anchor.current || !panel.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const height = panel.current.offsetHeight;
      const width = panel.current.offsetWidth;
      const right = Math.max(12, Math.min(window.innerWidth - rect.right, window.innerWidth - width - 12));
      const next = rect.top - height - 6 >= 12 ? { right, bottom: window.innerHeight - rect.top + 6 } : { right, top: rect.bottom + 6 };
      setPlace((current) => current && current.right === next.right && current.top === next.top && current.bottom === next.bottom ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [anchor]);
  useEffect(() => {
    const target = panel.current?.querySelector<HTMLElement>('[aria-checked="true"], [aria-pressed="true"], [aria-selected="true"]') ?? panel.current;
    target?.focus({ preventScroll: true });
  }, []);
  return createPortal(
    <div ref={panel} role="dialog" aria-label={label} tabIndex={-1} className={`send-key-panel${place ? " is-in" : ""}`}
      style={place ?? { right: 12, bottom: 12 }}>
      {children}
    </div>,
    document.body,
  );
}
