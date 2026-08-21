import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { maxBytesFor } from "@ash/shared";
import { UPLOADS_DIR } from "./paths.js";
import { id } from "./util.js";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT).map(([mime, ext]) => [`.${ext}`, mime]),
);
EXT_MIME[".jpeg"] = "image/jpeg";

type ImageBytes = { bytes: Buffer; mime: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function dataUrl(value: string): ImageBytes | null {
  const match = /^data:(image\/[^;,]+);base64,(.+)$/s.exec(value);
  return match ? { mime: match[1]!, bytes: Buffer.from(match[2]!, "base64") } : null;
}

function imageBlock(value: unknown): ImageBytes | null {
  const block = record(value);
  if (!block) return null;
  if (typeof block.image_url === "string") return dataUrl(block.image_url);
  if (block.type !== "image") return null;
  if (typeof block.data === "string" && typeof block.mimeType === "string") {
    return { mime: block.mimeType, bytes: Buffer.from(block.data, "base64") };
  }
  const source = record(block.source);
  if (source?.type === "base64" && typeof source.data === "string") {
    const mime = typeof source.media_type === "string" ? source.media_type : "image/png";
    return { mime, bytes: Buffer.from(source.data, "base64") };
  }
  return null;
}

function resultImages(value: unknown, allowBareBase64: boolean): ImageBytes[] {
  const root = record(value);
  const content = Array.isArray(value) ? value : Array.isArray(root?.content) ? root.content : [value];
  const images = content.map(imageBlock).filter((item): item is ImageBytes => item !== null);
  if (images.length || !allowBareBase64 || typeof value !== "string" || value.length < 128) return images;
  const fromDataUrl = dataUrl(value);
  return fromDataUrl ? [fromDataUrl] : [{ mime: "image/png", bytes: Buffer.from(value, "base64") }];
}

function storeImages(
  images: ImageBytes[],
  seen: Set<string>,
  directory: string,
): string[] {
  const stored: string[] = [];
  images.forEach(({ bytes, mime }, index) => {
    const ext = MIME_EXT[mime];
    if (!ext || !bytes.length || bytes.length > maxBytesFor(mime)) return;
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (seen.has(hash)) return;
    seen.add(hash);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${id()}-agent-image-${index + 1}.${ext}`);
    writeFileSync(path, bytes);
    stored.push(path);
  });
  return stored;
}

export function persistToolResultImages(
  value: unknown,
  seen = new Set<string>(),
  options: { allowBareBase64?: boolean; directory?: string } = {},
): string[] {
  return storeImages(resultImages(value, !!options.allowBareBase64), seen, options.directory ?? UPLOADS_DIR);
}

function markdownImagePaths(text: string): string[] {
  const paths: string[] = [];
  const pattern = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (!raw) continue;
    try {
      const path = raw.startsWith("file://") ? fileURLToPath(raw) : decodeURIComponent(raw);
      if (isAbsolute(path)) paths.push(path);
    } catch {
      /* malformed local URL */
    }
  }
  return [...new Set(paths)];
}

export function persistMarkdownImages(
  text: string,
  seen = new Set<string>(),
  directory = UPLOADS_DIR,
): string[] {
  const images: ImageBytes[] = [];
  for (const path of markdownImagePaths(text)) {
    const mime = EXT_MIME[extname(path).toLowerCase()];
    if (!mime || !existsSync(path)) continue;
    try { images.push({ mime, bytes: readFileSync(path) }); } catch { /* file disappeared */ }
  }
  return storeImages(images, seen, directory);
}
