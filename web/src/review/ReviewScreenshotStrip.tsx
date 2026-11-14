import { ImageSquare } from "@phosphor-icons/react";
import { PreviewableImage } from "../components/ImagePreview.tsx";

export interface ReviewScreenshotItem {
  key: string;
  name: string;
  src: string;
  label: string;
}

/**
 * `expired`：过了保留期、已经删掉的张数。删掉的不占缩略图位，只在标题行上照实报一句——这一轮
 * 原来有截图、现在没了，不能看着像审查者没截过。
 */
export function ReviewScreenshotStrip({ items, expired = 0 }: { items: ReviewScreenshotItem[]; expired?: number }) {
  if (!items.length && !expired) return null;
  const gone = expired ? `${items.length ? "另 " : ""}${expired} 张已过保留期` : null;
  return (
    <section className="review-screenshot-strip" aria-label={[`证据截图，共 ${items.length} 张`, gone].filter(Boolean).join("，")}>
      <header>
        <span><ImageSquare size={12} />证据截图</span>
        {items.length > 0 && <em>{items.length}</em>}
        {(gone || items.length > 2) && <small>{gone ?? "横向滚动查看"}</small>}
      </header>
      {items.length > 0 && <div className="review-screenshot-strip__rail" tabIndex={items.length > 2 ? 0 : undefined}>
        {items.map((item) => (
          <div className="review-screenshot-strip__item" key={item.key}>
            <PreviewableImage src={item.src} alt={item.name} label={item.label} loading="lazy" />
            <span>{item.name}</span>
          </div>
        ))}
      </div>}
    </section>
  );
}
