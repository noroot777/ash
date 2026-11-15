// 一份审查/验证报告在右侧面板里就地铺开的那一块：第一行是检查类型和起止（行尾一颗「在左侧
// 铺开看」），下面是正文、证据截图，和这一轮之后的事（驳回、辩论、裁定）。面板窄，报告长的时候点那颗
// 图标，同一份报告从左边推出来读（LeftDrawer，跟子智能体那个抽屉同一个位置），截图贴抽屉底边。
import type { ReactNode } from "react";
import { ArrowsOutSimple } from "@phosphor-icons/react";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { useLeftDrawer, type LeftDrawerEntry } from "../components/LeftDrawer.tsx";
import { InspTool } from "../inspector/parts.tsx";

export function ReviewInlineReport({ meta, entry, children, screenshots, after }: {
  /** 第一行那段灰字：检查类型、起止。没有就只剩行尾那颗图标。 */
  meta?: ReactNode;
  /** 铺到左侧抽屉里的那一屉；这一处没有抽屉可开（只读视图）时那颗图标不出。 */
  entry: LeftDrawerEntry;
  children: ReactNode;
  screenshots?: ReactNode;
  /** 截图之后的那几段（有驳回的那一轮：驳回、辩论、裁定）。抽屉里只铺报告，不带它们。 */
  after?: ReactNode;
}) {
  const drawer = useLeftDrawer();
  const wide = drawer?.activeKey === entry.key;
  // 就地那份和抽屉那份各是一组图片：翻大图时左右键只在同一份证据里走，不会数成两倍。
  return (
    <ImagePreviewGroup isolated>
      <div className="insp-report">
        <p className="insp-report__meta">
          <span className="insp-cut">{meta}</span>
          {drawer && (
            <InspTool label="在左侧铺开看" placement="left" aria-pressed={wide} onClick={() => (wide ? drawer.close() : drawer.open(entry))}>
              <ArrowsOutSimple size={14} aria-hidden="true" />
            </InspTool>
          )}
        </p>
        <div className="review-round-body">{children}</div>
        {screenshots}
        {after}
      </div>
    </ImagePreviewGroup>
  );
}
