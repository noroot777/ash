import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import { useEscape } from "./useEscape";
import { useReveal } from "./useReveal";

type ImageProps = ComponentPropsWithoutRef<"img">;

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
  moved: boolean;
};

export function ImageLightbox({
  src,
  alt,
  label,
  onClose,
}: {
  src: string;
  alt: string;
  label?: string;
  onClose: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const pendingZoomPointRef = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const [canZoom, setCanZoom] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const { closing, requestClose } = useReveal(onClose, "--modal-close-dur");
  useEscape(requestClose);

  const updateZoomAvailability = useCallback(() => {
    const image = imageRef.current;
    if (!image) return;
    const viewportPadding = window.matchMedia("(min-width: 640px)").matches ? 64 : 32;
    const nextCanZoom = image.naturalWidth > window.innerWidth - viewportPadding
      || image.naturalHeight > window.innerHeight - viewportPadding;
    setCanZoom(nextCanZoom);
    if (!nextCanZoom) setZoomed(false);
  }, []);

  useEffect(() => {
    window.addEventListener("resize", updateZoomAvailability);
    return () => window.removeEventListener("resize", updateZoomAvailability);
  }, [updateZoomAvailability]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const frame = requestAnimationFrame(() => {
      if (!zoomed) {
        viewport.scrollTo({ left: 0, top: 0 });
        return;
      }
      const image = imageRef.current;
      const point = pendingZoomPointRef.current;
      pendingZoomPointRef.current = null;
      if (!image || !point) return;
      const rect = image.getBoundingClientRect();
      const imageLeft = rect.left + viewport.scrollLeft;
      const imageTop = rect.top + viewport.scrollTop;
      viewport.scrollTo({
        left: imageLeft + point.x - point.clientX,
        top: imageTop + point.y - point.clientY,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [zoomed]);

  const toggleZoom = (clientX?: number, clientY?: number) => {
    if (!canZoom) return;
    if (!zoomed) {
      const image = imageRef.current;
      if (image) {
        const rect = image.getBoundingClientRect();
        const x = clientX ?? rect.left + rect.width / 2;
        const y = clientY ?? rect.top + rect.height / 2;
        pendingZoomPointRef.current = {
          x: ((x - rect.left) / rect.width) * image.naturalWidth,
          y: ((y - rect.top) / rect.height) * image.naturalHeight,
          clientX: x,
          clientY: y,
        };
      }
    }
    setZoomed((current) => !current);
  };

  const finishDrag = (event: PointerEvent<HTMLImageElement>, suppressClick: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    suppressClickRef.current = suppressClick && drag.moved;
    dragRef.current = null;
    setDragging(false);
  };

  // Lightboxes often sit above another Esc-aware modal or panel. Intercept in
  // capture phase so one Esc closes only the image,
  // rather than also reaching the already-mounted parent overlay listener.
  useEffect(() => {
    const interceptEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestClose();
    };
    document.addEventListener("keydown", interceptEscape, true);
    return () => document.removeEventListener("keydown", interceptEscape, true);
  }, [requestClose]);

  return createPortal(
    <div
      ref={viewportRef}
      role="dialog"
      aria-modal="true"
      aria-label={`图片预览：${label ?? alt}`}
      className={`t-modal-overlay ${closing ? "is-closing" : ""} fixed inset-0 z-[80] bg-black/85 p-4 sm:p-8 ${zoomed ? "overflow-auto" : "flex items-center justify-center overflow-hidden"}`}
      onClick={(event) => {
        // Portal events follow the React tree; stop here so a backdrop click
        // cannot also trigger a parent modal's click-outside close handler.
        event.stopPropagation();
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <button
        type="button"
        autoFocus
        aria-label="关闭图片预览"
        onClick={(event) => {
          event.stopPropagation();
          requestClose();
        }}
        className="fixed right-4 top-4 z-10 grid h-9 w-9 place-items-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
      >
        <X size={20} weight="bold" />
      </button>
      {label && (
        <div className="pointer-events-none fixed bottom-4 left-4 z-10 max-w-[min(80vw,720px)] truncate rounded-full bg-black/60 px-3 py-1.5 text-[11px] font-medium text-white/90 shadow-lg backdrop-blur-sm">
          {label}
        </div>
      )}
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        draggable={false}
        role={canZoom ? "button" : undefined}
        tabIndex={canZoom ? 0 : undefined}
        aria-label={canZoom ? `${alt}，${zoomed ? "缩小到适合屏幕" : "按原尺寸放大"}` : undefined}
        aria-pressed={canZoom ? zoomed : undefined}
        onLoad={updateZoomAvailability}
        onClick={(event) => {
          event.stopPropagation();
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          toggleZoom(event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (!canZoom || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          event.stopPropagation();
          toggleZoom();
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (!zoomed || event.button !== 0) return;
          const viewport = viewportRef.current;
          if (!viewport) return;
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            scrollLeft: viewport.scrollLeft,
            scrollTop: viewport.scrollTop,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          const viewport = viewportRef.current;
          if (!drag || !viewport || drag.pointerId !== event.pointerId) return;
          const deltaX = event.clientX - drag.startX;
          const deltaY = event.clientY - drag.startY;
          if (!drag.moved && Math.hypot(deltaX, deltaY) >= 4) {
            drag.moved = true;
            setDragging(true);
          }
          if (!drag.moved) return;
          viewport.scrollLeft = drag.scrollLeft - deltaX;
          viewport.scrollTop = drag.scrollTop - deltaY;
        }}
        onPointerUp={(event) => finishDrag(event, true)}
        onPointerCancel={(event) => finishDrag(event, false)}
        className={`t-modal ${closing ? "is-closing" : ""} mx-auto block h-auto w-auto select-none shadow-2xl ${zoomed ? `max-h-none max-w-none touch-none ${dragging ? "cursor-grabbing" : "cursor-zoom-out"}` : `max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] object-contain sm:max-h-[calc(100vh-4rem)] sm:max-w-[calc(100vw-4rem)] ${canZoom ? "cursor-zoom-in" : "cursor-default"}`}`}
      />
    </div>,
    document.body,
  );
}

// Shared clickable-image primitive. The thumbnail remains a real <img> so it can
// live safely inside Markdown paragraphs; the full-screen dialog is portaled to
// <body>, away from overflow/stacking contexts in bubbles, modals, and drawers.
export function PreviewableImage({
  src,
  alt,
  className = "",
  onClick,
  onKeyDown,
  title: _title,
  ...props
}: ImageProps) {
  const [open, setOpen] = useState(false);
  const label = alt || "图片";
  const openPreview = (event: MouseEvent<HTMLImageElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || !src) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(true);
  };

  return (
    <>
      <img
        {...props}
        src={src}
        alt={alt}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        className={`cursor-zoom-in ${className}`}
        onClick={openPreview}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented || !src || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      />
      {open && src && <ImageLightbox src={src} alt={label} onClose={() => setOpen(false)} />}
    </>
  );
}

// ReactMarkdown adds a private `node` prop to component renderers; consume it
// here instead of forwarding it to the DOM. Both Markdown surfaces use the same
// responsive thumbnail treatment and the shared lightbox above.
export function PreviewableMarkdownImage({
  node: _node,
  className = "",
  ...props
}: ImageProps & { node?: unknown }) {
  return (
    <PreviewableImage
      {...props}
      className={`my-2 max-h-[420px] max-w-full rounded-md border border-line2 bg-raised object-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 ${className}`}
    />
  );
}
