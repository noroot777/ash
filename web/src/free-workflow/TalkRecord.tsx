import { useEffect, useRef, type ReactNode } from "react";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { turnGist } from "./debateModel.ts";
import { SpeakingLine, type TalkSegment } from "./TalkOverview.tsx";

/**
 * 几方交替说几段的完整记录（左侧抽屉里那一屉）：一段一节，节与节之间一条细线；节头是谁、第几段（各自补一句，
 * 辩论写收尾那段的立场、讨论写第一轮「写的时候没看别人的」），下面先是那句摘要，再是完整发言。还在说的
 * 时候它跟着长。审查意见的辩论（DebateRecord.tsx）和讨论（DiscussionRecord.tsx）用的是这同一份。
 *
 * `focus`：打开时停在第几段（概览里点的那一行），不给 `seq` 就从头。按对象认：同一段再点一次（新的一份
 * `focus`）也再滚过去一次。
 */
export function TalkRecord({ segments, waiting, focus, headOf, keyOf }: {
  segments: readonly TalkSegment[];
  waiting?: { seq: number; who: string } | null;
  focus?: { seq?: number };
  /** 节头「第 N 段」后面补的那一句；null = 不补。 */
  headOf?: (segment: Pick<TalkSegment, "seq">) => string | null;
  /** 节头右端的一颗键（等裁定时的「用这段作要点」）。 */
  keyOf?: (segment: TalkSegment) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus?.seq == null) return;
    root.current?.querySelector(`[data-seq="${focus.seq}"]`)?.scrollIntoView({ block: "start" });
  }, [focus]);
  const head = (segment: Pick<TalkSegment, "seq">) => {
    const extra = headOf?.(segment);
    return `第 ${segment.seq} 段${extra ? ` · ${extra}` : ""}`;
  };
  return (
    <div className="debate-record" ref={root}>
      {segments.map((segment) => (
        <section key={segment.seq} className="debate-record-seg" data-seq={segment.seq} aria-label={`${segment.who}第 ${segment.seq} 段`}>
          <header>
            <b>{segment.who}</b>
            <span>{head(segment)}</span>
            {keyOf?.(segment)}
          </header>
          {segment.status === "speaking" ? <SpeakingLine className="debate-record-live" /> : (
            <>
              <p className="debate-record-gist">{turnGist(segment)}</p>
              {segment.statement && <MarkdownBody text={segment.statement} />}
            </>
          )}
        </section>
      ))}
      {waiting && (
        <section className="debate-record-seg" data-seq={waiting.seq}>
          <header><b>{waiting.who}</b><span>{head(waiting)}</span></header>
          <SpeakingLine className="debate-record-live" />
        </section>
      )}
    </div>
  );
}
