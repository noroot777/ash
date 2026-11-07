import { extname } from "node:path";

// 「哪些文件算产物」——拿来看、不是拿来读 diff 的那几类。生成物面板（task-artifact-scan.ts）
// 和执行器那一侧（executors/tool-writes.ts：只给这几类文件记内容指纹）共用这一张表。
//
// 文档（Markdown、Office）也算：方案、报告、说明这类交付物是拿来读的，在「改动」里它只是
// 一段加号行，跟网页的源码一样没法当成品看——Markdown 在查看器里按渲染后的样子摊开。

export type ArtifactKind = "image" | "video" | "audio" | "page" | "pdf" | "doc";

const KIND_BY_EXTENSION = new Map<string, ArtifactKind>([
  ...["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "heic", "tif", "tiff"]
    .map((ext) => [ext, "image"] as const),
  ...["mp4", "mov", "webm", "mkv", "avi", "m4v", "ogv"].map((ext) => [ext, "video"] as const),
  ...["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "aiff"].map((ext) => [ext, "audio"] as const),
  ...["html", "htm"].map((ext) => [ext, "page"] as const),
  ["pdf", "pdf"],
  ...["md", "markdown", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "ods", "odp", "rtf"]
    .map((ext) => [ext, "doc"] as const),
] as const satisfies readonly (readonly [string, ArtifactKind])[]);

export function kindOf(path: string): ArtifactKind | null {
  return KIND_BY_EXTENSION.get(extname(path).replace(/^\./, "").toLowerCase()) ?? null;
}
