import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CaretLeft, CaretRight, X } from "@phosphor-icons/react";

type ImageProps = ComponentPropsWithoutRef<"img"> & { label?: string };

export type PreviewImage = {
  src: string;
  alt: string;
  label?: string;
};

type ImageGroupContextValue = {
  register: (id: symbol, image: PreviewImage) => void;
  unregister: (id: symbol) => void;
  open: (id: symbol) => void;
};

type ActivePreview = {
  images: PreviewImage[];
  index: number;
};

const ImageGroupContext = createContext<ImageGroupContextValue | null>(null);

function ImageLightbox({
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
  const grouped = images.length > 1;
  const step = useCallback((delta: number) => {
    if (!grouped) return;
    onIndexChange((index + delta + images.length) % images.length);
  }, [grouped, images.length, index, onIndexChange]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  useEffect(() => {
    const interceptKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
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
  }, [grouped, onClose, step]);

  if (!current) return null;
  const label = current.label || current.alt || "图片";

  return createPortal(
    <div
      className="image-preview-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`图片预览：${label}`}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="image-preview-lightbox__meta">
        <span>{label}</span>
        <small>{index + 1} / {images.length}</small>
      </div>
      <button className="image-preview-lightbox__close" type="button" autoFocus aria-label="关闭图片预览" onClick={onClose}>
        <X size={19} weight="bold" aria-hidden="true" />
      </button>
      {grouped && (
        <button className="image-preview-lightbox__prev" type="button" aria-label="上一张图片" onClick={() => step(-1)}>
          <CaretLeft size={24} weight="bold" aria-hidden="true" />
        </button>
      )}
      <img src={current.src} alt={current.alt} draggable={false} onMouseDown={(event) => event.stopPropagation()} />
      {grouped && (
        <button className="image-preview-lightbox__next" type="button" aria-label="下一张图片" onClick={() => step(1)}>
          <CaretRight size={24} weight="bold" aria-hidden="true" />
        </button>
      )}
    </div>,
    document.body,
  );
}

function ImageGroupProvider({ children }: { children: ReactNode }) {
  const images = useRef(new Map<symbol, PreviewImage>());
  const [active, setActive] = useState<ActivePreview | null>(null);

  const register = useCallback((id: symbol, image: PreviewImage) => {
    images.current.set(id, image);
  }, []);
  const unregister = useCallback((id: symbol) => {
    images.current.delete(id);
  }, []);
  const open = useCallback((id: symbol) => {
    const entries = [...images.current.entries()];
    const index = entries.findIndex(([candidate]) => candidate === id);
    if (index < 0) return;
    setActive({ images: entries.map(([, image]) => image), index });
  }, []);
  const value = useMemo(() => ({ register, unregister, open }), [open, register, unregister]);

  return (
    <ImageGroupContext.Provider value={value}>
      {children}
      {active && (
        <ImageLightbox
          images={active.images}
          index={active.index}
          onIndexChange={(index) => setActive((current) => current ? { ...current, index } : null)}
          onClose={() => setActive(null)}
        />
      )}
    </ImageGroupContext.Provider>
  );
}

export function ImagePreviewGroup({ children, isolated = false }: { children: ReactNode; isolated?: boolean }) {
  const parent = useContext(ImageGroupContext);
  return parent && !isolated ? <>{children}</> : <ImageGroupProvider>{children}</ImageGroupProvider>;
}

export function PreviewableImage({
  src,
  alt,
  label,
  className = "",
  onClick,
  onKeyDown,
  ...props
}: ImageProps) {
  return (
    <ImagePreviewGroup>
      <GroupedPreviewableImage
        {...props}
        src={src}
        alt={alt}
        label={label}
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
  label,
  className = "",
  onClick,
  onKeyDown,
  ...props
}: ImageProps) {
  const id = useRef(Symbol("image-preview")).current;
  const group = useContext(ImageGroupContext)!;
  const imageAlt = alt || "图片";

  useLayoutEffect(() => {
    if (src) group.register(id, { src, alt: imageAlt, label: label || imageAlt });
    else group.unregister(id);
  }, [group, id, imageAlt, label, src]);

  useLayoutEffect(() => () => group.unregister(id), [group, id]);

  const open = (event: MouseEvent<HTMLImageElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || !src) return;
    event.preventDefault();
    event.stopPropagation();
    group.open(id);
  };
  const openWithKeyboard = (event: ReactKeyboardEvent<HTMLImageElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || !src || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    event.stopPropagation();
    group.open(id);
  };

  return (
    <img
      {...props}
      src={src}
      alt={imageAlt}
      role={src ? "button" : undefined}
      tabIndex={src ? 0 : undefined}
      aria-haspopup={src ? "dialog" : undefined}
      className={`image-preview-trigger ${className}`.trim()}
      onClick={open}
      onKeyDown={openWithKeyboard}
    />
  );
}
