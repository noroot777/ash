import { extname } from "node:path";

// 「哪些文件算产物」——拿来看、不是拿来读 diff 的那几类。生成物面板（task-artifact-scan.ts）
// 和执行器那一侧（executors/tool-writes.ts：只给这几类文件记内容指纹）共用这一张表。

export type ArtifactKind = "image" | "video" | "audio" | "page" | "pdf";

const KIND_BY_EXTENSION = new Map<string, ArtifactKind>([
  ...["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "heic", "tif", "tiff"]
    .map((ext) => [ext, "image"] as const),
  ...["mp4", "mov", "webm", "mkv", "avi", "m4v", "ogv"].map((ext) => [ext, "video"] as const),
  ...["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "aiff"].map((ext) => [ext, "audio"] as const),
  ...["html", "htm"].map((ext) => [ext, "page"] as const),
  ["pdf", "pdf"],
] as const satisfies readonly (readonly [string, ArtifactKind])[]);

export function kindOf(path: string): ArtifactKind | null {
  return KIND_BY_EXTENSION.get(extname(path).replace(/^\./, "").toLowerCase()) ?? null;
}
