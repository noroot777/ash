// 「AI 协助」的作业登记簿：一个项目一格，谁占着、现在什么状态、怎么落终态。
//
// 为什么从 preview-assist.ts 拆出来：那份要 `resolveExecutorFor`，顺着它会把整个
// `db/index.ts` 拉进来（import 一下就打开真的 ash 库并跑迁移）。而这里全是内存里的判断，
// 恰好又是**最该被回归测试钉住**的那一块（预占的原子性），所以留成一个不碰 DB 的模块，
// `test:preview-assist` 才能不带 ASH_DB、不起 CLI 智能体地测它。
import type { PreviewAssistState } from "@ash/shared/preview-assist";
import { PREVIEW_ASSIST_MAX_ROUNDS } from "@ash/shared/preview-assist";
import type { RunHandle } from "./executors/types.js";
import { id, now } from "./util.js";

export interface Job {
  state: PreviewAssistState;
  canceled: boolean;
  /** 正在跑的那个智能体回合，取消时要杀它。 */
  handle: RunHandle | null;
}

const jobs = new Map<string, Job>();
/** 结束的 job 留一会儿给前端把结果取走，之后自己清掉。 */
const KEEP_FINISHED_MS = 10 * 60_000;

export function previewAssistState(projectId: string): PreviewAssistState | null {
  return jobs.get(projectId)?.state ?? null;
}

/**
 * 预占这个项目的那一格。**同步**完成，`jobs.get` 和 `jobs.set` 中间一个 await 都不能有。
 *
 * 第 1 轮审查复现过：老实现在两者之间 `await resolveExecutorFor()`，同时点两下（两个页面、
 * 两个人）两个请求都能穿过「已经在跑了吗」这道检查，于是真起两个智能体，后写入的那个把
 * 前一个从索引里顶掉——被顶掉的那份**查不到也停不了**，就在用户的项目目录里一直跑着。
 *
 * 所以「挑执行器」「备环境」这些要 await 的准备工作一律排在预占**之后**，并且任何一步抛错
 * 都得把这一格落成终态（见 startPreviewAssist）——留着一条没有循环在跑的 `running`，界面会
 * 一直转圈，而且这个项目从此点不动那颗按钮。
 */
export function reservePreviewAssistJob(projectId: string): { job: Job; fresh: boolean } {
  const running = jobs.get(projectId);
  if (running?.state.status === "running") return { job: running, fresh: false };
  const job: Job = {
    canceled: false,
    handle: null,
    state: {
      jobId: id(),
      projectId,
      status: "running",
      phase: "starting",
      round: 0,
      maxRounds: PREVIEW_ASSIST_MAX_ROUNDS,
      // 执行器还没挑出来（那一步要查库）。界面这会儿显示的是下面这句 step，不是标签。
      executorLabel: "",
      step: "正在挑执行器…",
      say: "",
      attempts: [],
      script: null,
      url: null,
      error: null,
      startedAt: now(),
      endedAt: null,
    },
  };
  jobs.set(projectId, job);
  return { job, fresh: true };
}

/** 用户点了取消。返回 false = 本来就没有在跑的。 */
export function cancelPreviewAssist(projectId: string): boolean {
  const job = jobs.get(projectId);
  if (!job || job.state.status !== "running") return false;
  job.canceled = true;
  try { job.handle?.kill(); } catch { /* 已经退了 */ }
  finishPreviewAssistJob(job, "canceled", "已取消");
  return true;
}

export function finishPreviewAssistJob(job: Job, status: PreviewAssistState["status"], error: string | null): void {
  if (job.state.status !== "running") return;
  job.state.status = status;
  job.state.phase = "done";
  job.state.error = error;
  job.state.endedAt = now();
  job.state.step = status === "succeeded"
    ? `已在 ${job.state.url ?? "借来的端口"} 上真的起来过一次`
    : error ?? "已结束";
  const projectId = job.state.projectId;
  setTimeout(() => {
    if (jobs.get(projectId) === job) jobs.delete(projectId);
  }, KEEP_FINISHED_MS).unref?.();
}
