import { MAX_IMAGE_BYTES, maxBytesFor } from "@ash/shared";
import { drawAnnotations } from "./render.ts";
import type { AnnotationImage, ScreenshotCandidate, ScreenshotDraft } from "./model.ts";

export function readImageData(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败，请重新选择"));
    reader.readAsDataURL(file);
  });
}

function decodeImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取这张图片，请重新上传截图"));
    image.src = url;
  });
}

function imageCanvas(width: number, height: number) {
  if (!width || !height || width > 16384 || height > 16384 || width * height > 32_000_000) {
    throw new Error("图片尺寸过大或无效，请裁剪后重试（最多 3200 万像素，单边不超过 16384 px）");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法打开图片画布，请重新打开批注");
  return { canvas, context };
}

export async function loadScreenshot(input: File | ScreenshotCandidate, source: AnnotationImage["source"]): Promise<AnnotationImage> {
  if (input instanceof File) {
    if (!input.type.startsWith("image/")) throw new Error("请选择图片文件");
    if (input.size > maxBytesFor(input.type)) throw new Error(`图片过大，上限 ${maxBytesFor(input.type) / 1048576} MB`);
  }
  const decoded = await decodeImage(input instanceof File ? await readImageData(input) : input.url);
  const width = decoded.naturalWidth;
  const height = decoded.naturalHeight;
  const { canvas, context } = imageCanvas(width, height);
  context.drawImage(decoded, 0, 0);
  const dataUrl = canvas.toDataURL("image/png");
  if (!dataUrl.startsWith("data:image/png")) throw new Error("无法生成截图，请裁剪图片后重试");
  return {
    dataUrl, width, height, source,
    name: input.name || "粘贴的截图.png",
    ...(input instanceof File ? {} : { sourcePath: input.path }),
  };
}

export async function exportScreenshot(draft: ScreenshotDraft): Promise<{ dataUrl: string; extension: string }> {
  const image = await decodeImage(draft.image.dataUrl);
  const { canvas, context } = imageCanvas(draft.image.width, draft.image.height);
  context.drawImage(image, 0, 0);
  drawAnnotations(context, draft.annotations, canvas.width, canvas.height);
  const asBlob = (type: string, quality?: number) => new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("标注图片导出失败，内容已保留")), type, quality);
  });
  let blob = await asBlob("image/png");
  if (blob.size > MAX_IMAGE_BYTES) {
    context.save();
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
    for (const quality of [0.92, 0.8, 0.65]) {
      blob = await asBlob("image/jpeg", quality);
      if (blob.size <= MAX_IMAGE_BYTES) break;
    }
  }
  if (blob.size > MAX_IMAGE_BYTES) throw new Error("标注图片超过附件的 5 MB 上限，请使用裁剪后的截图；当前批注已保留");
  return { dataUrl: await readImageData(blob), extension: blob.type === "image/jpeg" ? "jpg" : "png" };
}
