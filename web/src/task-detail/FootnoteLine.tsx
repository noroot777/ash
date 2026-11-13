import { Fragment, useId, useState, type ReactNode } from "react";
import { DeleteMessageButton, type DeletableItem } from "./MessageDelete.tsx";
import type { NoticeView } from "./timelineNoticeCopy.ts";
import { footnotePartTail, type FootnotePart, type TurnFootnote } from "./turnFootnote.ts";

/** 句子里的分支名、标签名换成等宽字（不垫底色）。 */
function SentenceText({ view }: { view: Pick<NoticeView, "text" | "mono"> }) {
  const at = view.mono ? view.text.indexOf(view.mono) : -1;
  if (!view.mono || at < 0) return <>{view.text}</>;
  return (
    <>
      {view.text.slice(0, at)}
      <code className="turn-footnote-mono">{view.mono}</code>
      {view.text.slice(at + view.mono.length)}
    </>
  );
}

/** 坏消息、又还是现在的事：字前面一颗小圆点（红 = 没办成，琥珀 = 要你知道或拍板）。 */
export function FootnoteDot({ tone, live }: { tone: NoticeView["tone"]; live: boolean }) {
  if (!live || (tone !== "bad" && tone !== "warn")) return null;
  return <span className={`turn-footnote-dot is-${tone}`} aria-hidden="true" />;
}

/**
 * 回合的尾注：回合正文下面、回合尾那排操作上面的一句小灰字（模型与归属见 turnFootnote /
 * conversationSystemRows）。没有图标、没有底色，几件事并成一句、中间一个间隔号。
 *
 * - 指到这一句（键盘走进来）才出最近那一句的时刻（是哪条命令 · 时刻），触屏上常显；
 * - 有原文细节的那半句点了就地摊开原文；
 * - 挂在某半句后面的键（「去裁定」）由 `actionFor` 给，紧跟在那半句后面，时刻排在键后面；
 * - 删除不在这里：每一句同时也是「N 条记录」里的一条，删除在那儿。只有没有记录可去的地方
 *   （团队时间线）才给 `deletable`。
 *
 * 审查结论不在这里（它在会话右边自己占一行，见 ReviewVerdict）；贴在它下面的那几句也用这一句，
 * `placement="trailing"`：靠右，时刻排在字前面——藏着的时刻若在字后面，靠右的那句字就对不齐气泡。
 */
export function FootnoteLine({
  footnote,
  actionFor,
  placement = "turn",
  deletable,
}: {
  footnote: TurnFootnote;
  actionFor?: (part: FootnotePart) => ReactNode;
  /** turn = 回合正文下面；standalone = 前面没有回合可挂、在原处单独占一行；trailing = 贴在审查结论下面。 */
  placement?: "turn" | "standalone" | "trailing";
  deletable?: DeletableItem;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const bodyId = useId();
  const { parts, live } = footnote;
  if (!parts.length) return null;
  const tail = footnotePartTail(parts.at(-1)!);
  const opened = parts.find((part) => part.id === open) ?? null;
  const toggle = (id: string) => setOpen((value) => value === id ? null : id);

  const sentence = (part: FootnotePart) => {
    const text = <span className="turn-footnote-text" data-selection-content=""><SentenceText view={part.view} /></span>;
    const dot = <FootnoteDot tone={part.view.tone} live={live} />;
    // 验收那句只是报个结果，不能点（分支名已经写在字里，原文在「N 条记录」里点开）。
    if (part.view.detail && part.view.topic !== "accept") {
      return (
        <button
          type="button"
          className="turn-footnote-part"
          aria-expanded={open === part.id}
          aria-controls={bodyId}
          onClick={() => toggle(part.id)}
        >
          {dot}{text}
        </button>
      );
    }
    return <span className="turn-footnote-part is-static">{dot}{text}</span>;
  };

  return (
    <div
      className={`turn-footnote${placement === "turn" ? "" : ` is-${placement}`}`}
      role={live && parts.some((part) => part.view.tone === "bad" || part.view.tone === "warn") ? "status" : undefined}
    >
      <p className="turn-footnote-line">
        {parts.map((part, index) => (
          <Fragment key={part.id}>
            {index > 0 && <span className="turn-footnote-sep" aria-hidden="true">·</span>}
            {sentence(part)}
            {actionFor?.(part)}
          </Fragment>
        ))}
        {tail && <time className="turn-footnote-tail">{tail}</time>}
        {deletable && <DeleteMessageButton item={deletable} />}
      </p>
      {opened && opened.view.detail && opened.view.topic !== "accept" && (
        <p className="turn-footnote-detail" id={bodyId}>{opened.view.detail}</p>
      )}
    </div>
  );
}
