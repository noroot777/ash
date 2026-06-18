import { useState, useCallback, type ClipboardEvent } from "react";
import { X } from "@phosphor-icons/react";
import { api } from "./api";

// One pasted image: `url` previews the thumbnail, `path` is the absolute file
// path handed to the agent (it reads the image with its Read tool).
export type PastedImage = { url: string; path: string };

// Shared paste-to-upload behavior for the composer + reply box. Captures images
// from a paste event, uploads them, and tracks the resulting {url,path} list.
export function usePasteImages() {
  const [images, setImages] = useState<PastedImage[]>([]);
  const onPaste = useCallback(async (e: ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []).filter((it) => it.type.startsWith("image/"));
    if (!items.length) return; // let normal text paste through
    e.preventDefault();
    for (const it of items) {
      const file = it.getAsFile();
      if (!file) continue;
      try {
        const dataUrl = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.onerror = () => rej(r.error);
          r.readAsDataURL(file);
        });
        const up = await api.uploadImage(dataUrl);
        setImages((xs) => [...xs, { url: up.url, path: up.path }]);
      } catch (err) {
        console.warn("image upload failed:", err);
      }
    }
  }, []);
  const remove = useCallback((url: string) => setImages((xs) => xs.filter((x) => x.url !== url)), []);
  const clear = useCallback(() => setImages([]), []);
  return { images, onPaste, remove, clear };
}

// Row of removable image thumbnails shown under an input once images are pasted.
export function ImageChips({ images, onRemove }: { images: PastedImage[]; onRemove: (url: string) => void }) {
  if (!images.length) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      {images.map((img) => (
        <div key={img.url} className="group relative h-14 w-14 overflow-hidden rounded-md border border-line2">
          <img src={img.url} alt="" className="h-full w-full object-cover" />
          <button
            onClick={() => onRemove(img.url)}
            className="absolute right-0 top-0 grid h-4 w-4 place-items-center rounded-bl bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
            title="移除"
          >
            <X size={10} weight="bold" />
          </button>
        </div>
      ))}
    </div>
  );
}
