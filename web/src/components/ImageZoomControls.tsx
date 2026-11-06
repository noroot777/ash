import { Minus, Plus } from "@phosphor-icons/react";
import type { ImageZoom } from "./useImageZoom.ts";

/** 缩放工具条：钉在看图容器底部居中，容器得是定位元素。 */
export function ImageZoomControls({ zoom }: { zoom: ImageZoom }) {
  return (
    <div className="image-zoom-controls" role="group" aria-label="缩放">
      <button type="button" aria-label="缩小图片" disabled={!zoom.canZoomOut} onClick={zoom.zoomOut}>
        <Minus size={15} weight="bold" aria-hidden="true" />
      </button>
      <button type="button" aria-label="适应窗口 / 实际大小" onClick={() => zoom.toggle()}>
        {zoom.percent}%
      </button>
      <button type="button" aria-label="放大图片" disabled={!zoom.canZoomIn} onClick={zoom.zoomIn}>
        <Plus size={15} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );
}
