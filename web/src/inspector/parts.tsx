// 右侧面板各格共用的六个公共件：分节标题、键值行、入口行、空状态、提示条、按钮；
// 外加面板头上的小图标钮、复制钮和卡片外框。样式在 styles/inspector-parts.css。
//
// 以前每一格各有一套版式：段标题十几种写法，空状态、提示条、主按钮各家一份私有样式。
// 收到这一处之后，一格里该长什么样只剩「挑哪几样件、按什么顺序摆」。卡片只统一外框，
// 里面怎么排各管各的。
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { CaretRight, Check, Copy } from "@phosphor-icons/react";
import { HoverTip, useHoverTip, type HoverTipPlacement } from "../components/HoverTip.tsx";

/** 分节标题：小一号的灰字，后面可跟一个数（淡一档）和行尾的东西。分节主要靠留白。 */
export function InspSec({ children, count, tail, id }: {
  children: ReactNode;
  count?: ReactNode;
  tail?: ReactNode;
  id?: string;
}) {
  return (
    <h3 className="insp-sec" id={id}>
      <span>{children}</span>
      {count != null && count !== "" && <b>{count}</b>}
      {tail}
    </h3>
  );
}

/** 一组「标签 值」。里面放 {@link InspRow}（或别的 dt/dd 对）。 */
export function InspKv({ children, className = "", label }: { children: ReactNode; className?: string; label?: string }) {
  return <dl className={`insp-kv ${className}`.trim()} aria-label={label}>{children}</dl>;
}

/** 键值行：一种行、一种字号。`wide` 的那一行不分左右两列，整行给值（点开的追问、表单）。 */
export function InspRow({ label, children, wide = false, className = "" }: {
  label?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  if (wide) return <dd className={`insp-kv__wide ${className}`.trim()}>{children}</dd>;
  return (
    <>
      <dt className={className}>{label}</dt>
      <dd className={className}>{children}</dd>
    </>
  );
}

/** 入口行：整行可点，左边是去哪儿，右边可带一段灰字，末尾一颗箭头。 */
export const InspGo = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { meta?: ReactNode }>(
  function InspGo({ children, meta, className = "", type = "button", ...props }, ref) {
    return (
      <button ref={ref} type={type} className={`insp-go ${className}`.trim()} {...props}>
        <span className="insp-cut">{children}</span>
        {meta != null && <span className="insp-meta">{meta}</span>}
        <CaretRight size={12} aria-hidden="true" className="insp-go__chev" />
      </button>
    );
  },
);

/** 空状态：一句话，至多一个动作。 */
export function InspNone({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="insp-none">
      <p>{children}</p>
      {action}
    </div>
  );
}

export type InspNoteTone = "plain" | "warn" | "bad" | "ok";

/** 提示条：一行灰底的字，前面一个图标；警告、出错、好消息只换图标颜色和一层淡底。 */
export function InspNote({ tone = "plain", icon, children, action, role }: {
  tone?: InspNoteTone;
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div className={`insp-note${tone === "plain" ? "" : ` is-${tone}`}`} role={role}>
      {icon && <span className="insp-note__icon" aria-hidden="true">{icon}</span>}
      <div className="insp-note__text">{children}</div>
      {action}
    </div>
  );
}

export type InspButtonVariant = "default" | "pri" | "quiet" | "danger";

/** 按钮：描边的默认键、纯黑实心的主键（深色反过来）、不描边的安静键、红字的危险键。 */
export const InspButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: InspButtonVariant;
  size?: "md" | "sm";
}>(function InspButton({ variant = "default", size = "md", className = "", type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={`insp-btn${variant === "default" ? "" : ` is-${variant}`}${size === "sm" ? " is-sm" : ""} ${className}`.trim()}
      {...props}
    />
  );
});

/** 面板头、行尾的小图标钮：只画图标，指到或键盘走到才报名字（应用内提示，不用原生 title）。 */
export const InspTool = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  tip?: ReactNode;
  placement?: HoverTipPlacement;
}>(function InspTool({ label, tip, placement = "below", className = "", type = "button", children, ...props }, ref) {
  const hover = useHoverTip({ placement });
  return (
    <>
      <button
        ref={ref}
        type={type}
        className={`insp-tool ${className}`.trim()}
        aria-label={label}
        {...hover.anchorProps}
        {...props}
      >
        {children}
      </button>
      <HoverTip at={hover.at}>{tip ?? label}</HoverTip>
    </>
  );
});

/** 复制钮：平时藏着，指到所在的那一行才出；点了换成一个勾，过一会儿换回来。 */
export function InspCopy({ text, label, onError }: { text: string; label: string; onError?: (message: string) => void }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <InspTool
      label={label}
      tip={done ? "已复制" : label}
      className="insp-copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setDone(false), 1400);
        } catch {
          onError?.("复制失败，请检查浏览器剪贴板权限后重试");
        }
      }}
    >
      {done ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </InspTool>
  );
}

/** 卡片：只统一外框（描边、圆角、内边距），里面怎么排各格自己定。 */
export function InspCard({ children, className = "", as: Tag = "article", ...rest }: {
  children: ReactNode;
  className?: string;
  as?: "article" | "div" | "section";
  "aria-label"?: string;
}) {
  return <Tag className={`insp-card ${className}`.trim()} {...rest}>{children}</Tag>;
}
