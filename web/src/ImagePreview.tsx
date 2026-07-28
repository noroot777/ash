import { useEffect, useState, type ComponentPropsWithoutRef, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import { useEscape } from "./useEscape";
import { useReveal } from "./useReveal";

type ImageProps = ComponentPropsWithoutRef<"img">;

function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const { closing, requestClose } = useReveal(onClose, "--modal-close-dur");
  useEscape(requestClose);
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
      role="dialog"
      aria-modal="true"
      aria-label={`图片预览：${alt}`}
      className={`t-modal-overlay ${closing ? "is-closing" : ""} fixed inset-0 z-[80] flex items-center justify-center bg-black/85 p-4 sm:p-8`}
      onClick={(event) => {
        // Portal events follow the React tree; stop here so a backdrop click
        // cannot also trigger a parent modal's click-outside close handler.
        event.stopPropagation();
        requestClose();
      }}
    >
      <button
        type="button"
        autoFocus
        aria-label="关闭图片预览"
        title="关闭 Esc"
        onClick={(event) => {
          event.stopPropagation();
          requestClose();
        }}
        className="absolute right-4 top-4 z-10 grid h-9 w-9 place-items-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
      >
        <X size={20} weight="bold" />
      </button>
      <div
        className={`t-modal ${closing ? "is-closing" : ""} flex max-h-full max-w-full items-center justify-center`}
        onClick={(event) => event.stopPropagation()}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] select-none object-contain shadow-2xl sm:max-h-[calc(100vh-4rem)] sm:max-w-[calc(100vw-4rem)]"
        />
      </div>
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
  title,
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
        title={title ?? `预览 ${label}`}
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
