// 一份审查/验证报告在右侧面板里就地铺开的那一块：第一行是检查类型和起止（行尾一颗「在左侧
// 铺开看」），下面是正文和证据截图。面板窄，报告长的时候点那颗图标，同一份正文装进贴着
// 面板左边缘的抽屉里看，截图贴抽屉底边（ReviewEvidenceDrawer）。
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowsOutSimple } from "@phosphor-icons/react";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { InspTool } from "../inspector/parts.tsx";
import { ReviewEvidenceDrawer } from "./ReviewEvidenceDrawer.tsx";

export function ReviewInlineReport({ meta, title, subtitle, anchorRef, children, screenshots }: {
  /** 第一行那段灰字：检查类型、起止。没有就只剩行尾那颗图标。 */
  meta?: ReactNode;
  /** 铺到抽屉里时的标题和副标题。 */
  title: string;
  subtitle: string;
  /** 抽屉贴着谁的左边缘弹（右侧面板那一格）。 */
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  screenshots?: ReactNode;
}) {
  const [wide, setWide] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 就地那份和抽屉那份各是一组图片：翻大图时左右键只在同一份证据里走，不会数成两倍。
  return (
    <>
      <ImagePreviewGroup isolated>
        <div ref={bodyRef} className="insp-report">
          <p className="insp-report__meta">
            <span className="insp-cut">{meta}</span>
            <InspTool label="在左侧铺开看" placement="left" aria-pressed={wide} onClick={() => setWide((current) => !current)}>
              <ArrowsOutSimple size={14} aria-hidden="true" />
            </InspTool>
          </p>
          <div className="review-round-body">{children}</div>
          {screenshots}
        </div>
      </ImagePreviewGroup>
      {wide && (
        <ImagePreviewGroup isolated>
          <ReviewEvidenceDrawer
            anchorRef={anchorRef}
            keepOpenRef={bodyRef}
            title={title}
            subtitle={subtitle}
            onClose={() => setWide(false)}
            footer={screenshots || undefined}
          >
            <div className="review-round-body">{children}</div>
          </ReviewEvidenceDrawer>
        </ImagePreviewGroup>
      )}
    </>
  );
}
