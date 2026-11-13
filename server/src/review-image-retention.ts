// 自由审查截图（`free-review/<审查>/round-N/` 下的 png/jpg/webp）的保留期。判据（了结身份 +
// 满 KEEP_DAYS）和清扫本身在 run-retention.ts，这里只说清删哪几份、删了怎么交代。
//
// 只删图片：report.md、review.diff、日志这些文字产物审查历史还要读，一份不碰。「图片」认的是
// 证据接口服务得了、截图条铺得出来的那一张表（evidence-path.ts 的 EVIDENCE_IMAGE_EXTENSIONS），
// 列举也走截图条那一份（free-review-files.ts），两边不会一边删得到、一边看不见。
//
// 删之前先把名字记进任务目录根上的过期清单（EXPIRED_REVIEW_IMAGES）：界面靠它把报告里、截图
// 条里那几张画成「已过保留期」，而不是「图取不到」加一个「再试一次」——那句话说的是临时故障，
// 对一张再也回不来的图是误导。先记后删：记不上就一张不删（抛错，这个任务的截图这一趟跳过）。
import { lstatSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bus } from "./bus.js";
import {
  EXPIRED_REVIEW_IMAGES,
  expiredRoundKey,
  freeReviewEvidenceDir,
  freeReviewScreenshots,
  readExpiredReviewImages,
} from "./free-review-files.js";
import type { RetainedKind } from "./run-retention.js";

const ROUND_DIR = /^round-([1-9]\d*)$/;

/** 真目录的名字（符号链接一律不跟：审查者建的链接可能指到运行目录之外）。 */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

type Image = { key: string; name: string; path: string };

function reviewImagesOf(taskId: string, dir: string): Image[] {
  const images: Image[] = [];
  for (const runId of subdirs(join(dir, "free-review"))) {
    for (const roundDir of subdirs(join(dir, "free-review", runId))) {
      const round = Number(ROUND_DIR.exec(roundDir)?.[1]);
      if (!round) continue;
      const base = freeReviewEvidenceDir(taskId, runId, round);
      for (const name of freeReviewScreenshots(taskId, runId, round)) {
        images.push({ key: expiredRoundKey(runId, round), name, path: join(base, ...name.split("/")) });
      }
    }
  }
  return images;
}

export const reviewImages: RetainedKind = {
  pending: (taskId, dir) => reviewImagesOf(taskId, dir).length > 0,
  reclaim(taskId, dir, due) {
    const doomed: (Image & { size: number })[] = [];
    for (const image of reviewImagesOf(taskId, dir)) {
      try {
        const st = lstatSync(image.path);
        if (st.isFile() && !st.isSymbolicLink() && due(st.mtimeMs)) doomed.push({ ...image, size: st.size });
      } catch {
        /* 列出来之后就没了：跳过 */
      }
    }
    if (!doomed.length) return { removed: 0, bytes: 0 };
    const expired = readExpiredReviewImages(taskId);
    for (const { key, name } of doomed) expired[key] = [...new Set([...(expired[key] ?? []), name])].sort();
    // 写临时文件再换名：写到一半断电留下半份 JSON，读的一方只能当空清单，前面几趟删掉的就都
    // 说不出原因了。
    const path = join(dir, EXPIRED_REVIEW_IMAGES);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(expired)}\n`);
    renameSync(`${path}.tmp`, path);
    let removed = 0;
    let bytes = 0;
    for (const image of doomed) {
      try {
        unlinkSync(image.path);
        removed++;
        bytes += image.size;
      } catch {
        /* 删不掉：清单里记着也无妨，文件还在就照常显示 */
      }
    }
    // 开着这个任务的页面要立刻换成「已过保留期」：发事件推进状态修订号、叫前端重取。指纹里
    // 也算了证据（free-workflow-state.ts），这里是不等轮询的那一半。
    if (removed) bus.publish({ type: "task.review", taskId });
    return { removed, bytes };
  },
};
