import { ImageSquare } from "@phosphor-icons/react";
import { PreviewableImage } from "../components/ImagePreview.tsx";

export interface ReviewScreenshotItem {
  key: string;
  name: string;
  src: string;
  label: string;
}

export function ReviewScreenshotStrip({ items }: { items: ReviewScreenshotItem[] }) {
  if (!items.length) return null;
  return (
    <section className="review-screenshot-strip" aria-label={`证据截图，共 ${items.length} 张`}>
      <header>
        <span><ImageSquare size={12} />证据截图</span>
        <em>{items.length}</em>
        {items.length > 2 && <small>横向滚动查看</small>}
      </header>
      <div className="review-screenshot-strip__rail" tabIndex={items.length > 2 ? 0 : undefined}>
        {items.map((item) => (
          <div className="review-screenshot-strip__item" key={item.key}>
            <PreviewableImage src={item.src} alt={item.name} label={item.label} loading="lazy" />
            <span>{item.name}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
