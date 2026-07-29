import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CaretLeft, CaretRight, X } from "@phosphor-icons/react";
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

export type PreviewImage = {
  src: string;
  alt: string;
  label?: string;
};

type ImageGroupContextValue = {
  register: (id: string, image: PreviewImage) => void;
  unregister: (id: string) => void;
  open: (id: string) => void;
};

const ImageGroupContext = createContext<ImageGroupContextValue | null>(null);

function ImageGroupProvider({ children }: { children: ReactNode }) {
  const imagesRef = useRef(new Map<string, PreviewImage>());
  const [revision, setRevision] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);

  const register = useCallback((id: string, image: PreviewImage) => {
    const current = imagesRef.current.get(id);
    if (current?.src === image.src && current.alt === image.alt && current.label === image.label) return;
    imagesRef.current.set(id, image);
    setRevision((value) => value + 1);
  }, []);

  const unregister = useCallback((id: string) => {
    if (!imagesRef.current.delete(id)) return;
    setRevision((value) => value + 1);
  }, []);

  const value = useMemo(() => ({ register, unregister, open: setActiveId }), [register, unregister]);
  const entries = useMemo(() => [...imagesRef.current.entries()], [revision]);
  const activeIndex = activeId === null ? -1 : entries.findIndex(([id]) => id === activeId);

  useEffect(() => {
    if (activeId !== null && activeIndex < 0) setActiveId(null);
  }, [activeId, activeIndex]);

  return (
    <ImageGroupContext.Provider value={value}>
      {children}
      {activeIndex >= 0 && (
        <ImageLightbox
          images={entries.map(([, image]) => image)}
          index={activeIndex}
          onIndexChange={(index) => setActiveId(entries[index]?.[0] ?? null)}
          onClose={() => setActiveId(null)}
        />
      )}
    </ImageGroupContext.Provider>
  );
}

// Nested boundaries deliberately reuse the nearest group. This lets leaf
// renderers be safe by default while a message/note can merge several image
// sources into one natural navigation context with one outer boundary.
export function ImagePreviewGroup({ children, isolated = false }: { children: ReactNode; isolated?: boolean }) {
  const parent = useContext(ImageGroupContext);
  return parent && !isolated ? <>{children}</> : <ImageGroupProvider>{children}</ImageGroupProvider>;
}

export function ImageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: PreviewImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const current = images[index] ?? images[0];
  const src = current?.src ?? "";
  const alt = current?.alt ?? "图片";
  const label = current?.label;
  const grouped = images.length > 1;
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

  const resetView = useCallback(() => {
    dragRef.current = null;
    suppressClickRef.current = false;
    pendingZoomPointRef.current = null;
    setCanZoom(false);
    setZoomed(false);
    setDragging(false);
    viewportRef.current?.scrollTo({ left: 0, top: 0 });
  }, []);

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
    resetView();
  }, [resetView, src]);

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

  const step = useCallback((delta: number) => {
    if (!grouped) return;
    resetView();
    onIndexChange((index + delta + images.length) % images.length);
  }, [grouped, images.length, index, onIndexChange, resetView]);

  // Lightboxes often sit above another Esc-aware modal or panel. Intercept in
  // capture phase so one Esc closes only the image, and reserve horizontal
  // arrows for group navigation instead of scrolling a zoomed viewport.
  useEffect(() => {
    const interceptKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        requestClose();
      } else if (event.key === "ArrowLeft" && grouped) {
        event.preventDefault();
        event.stopImmediatePropagation();
        step(-1);
      } else if (event.key === "ArrowRight" && grouped) {
        event.preventDefault();
        event.stopImmediatePropagation();
        step(1);
      }
    };
    document.addEventListener("keydown", interceptKeys, true);
    return () => document.removeEventListener("keydown", interceptKeys, true);
  }, [grouped, requestClose, step]);

  if (!current) return null;

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
      {grouped && (
        <>
          <button
            type="button"
            aria-label="上一张图片"
            onClick={(event) => {
              event.stopPropagation();
              step(-1);
            }}
            className="fixed left-3 top-1/2 z-10 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 sm:left-5"
          >
            <CaretLeft size={24} weight="bold" />
          </button>
          <button
            type="button"
            aria-label="下一张图片"
            onClick={(event) => {
              event.stopPropagation();
              step(1);
            }}
            className="fixed right-3 top-1/2 z-10 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 sm:right-5"
          >
            <CaretRight size={24} weight="bold" />
          </button>
          <div className="pointer-events-none fixed left-1/2 top-4 z-10 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1.5 text-[11px] font-semibold tabular-nums text-white/90 shadow-lg backdrop-blur-sm">
            {index + 1}/{images.length}
          </div>
        </>
      )}
      {label && (
        <div className="pointer-events-none fixed bottom-4 left-4 z-10 max-w-[min(80vw,720px)] truncate rounded-full bg-black/60 px-3 py-1.5 text-[11px] font-medium text-white/90 shadow-lg backdrop-blur-sm">
          {label}
        </div>
      )}
      <img
        key={src}
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
  return (
    <ImagePreviewGroup>
      <GroupedPreviewableImage
        {...props}
        src={src}
        alt={alt}
        className={className}
        onClick={onClick}
        onKeyDown={onKeyDown}
      />
    </ImagePreviewGroup>
  );
}

function GroupedPreviewableImage({
  src,
  alt,
  className = "",
  onClick,
  onKeyDown,
  title: _title,
  ...props
}: ImageProps) {
  const id = useId();
  const group = useContext(ImageGroupContext)!;
  const label = alt || "图片";

  useLayoutEffect(() => {
    if (src) group.register(id, { src, alt: label, label });
    else group.unregister(id);
  }, [group, id, label, src]);

  useLayoutEffect(() => {
    return () => group.unregister(id);
  }, [group, id]);

  const openPreview = (event: MouseEvent<HTMLImageElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || !src) return;
    event.preventDefault();
    event.stopPropagation();
    group.open(id);
  };

  return (
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
        group.open(id);
      }}
    />
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
