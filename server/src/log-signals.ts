// 写进日志、给**别的进程**读的那几句信号。读的一侧新旧前缀都认（见 legacy-names.ts 的 LEGACY_LOG_TAG）。
import { LEGACY_LOG_TAG } from "@ash/shared/legacy-names";

export const LOG_TAG = "[navi]";
const LOG_TAGS = [LOG_TAG, LEGACY_LOG_TAG] as const;

/** 服务端的调度器起来了（`schedules.ts` 打）。预览实例绝不该打出这一句。 */
export const SCHEDULER_STARTED = `${LOG_TAG} scheduler started`;

/** 这一段日志里有没有「调度器起来了」—— 任一代前缀都算。 */
export const mentionsSchedulerStarted = (text: string): boolean =>
  LOG_TAGS.some((tag) => text.includes(`${tag} scheduler started`));

/** `[navi] preview-api-host <主机>:<端口>`（旧前缀 `[ash]` 同样认），见 preview-log.ts。 */
export const PREVIEW_API_HOST_RE = new RegExp(
  `(?:${LOG_TAGS.map((tag) => tag.replace(/[[\]]/g, "\\$&")).join("|")}) preview-api-host (?:localhost|127\\.0\\.0\\.1|\\[::1\\]):(\\d{2,5})\\b`,
  "i",
);
