// 「AI 协助」在浏览器本地记的两件事。
//
// ① 选了谁来判断 —— 一次性的选择，记在本地按项目记就够，不进库（它不像任务的执行器那样
//    要被别人、被重启后的服务端读到）。
// ② **这个浏览器点过的那个作业** —— 服务端的进度是内存态（server/src/preview-assist.ts 说了
//    为什么不落库），GET 回来 `job: null` 的原因有三种，而这三种在用户眼里是完全不同的事：
//      · 从来没点过              → 什么都不该显示
//      · 点过，ash 重启吞了它    → 「已随 ash 重启中断」（第 1 轮审查：原来这一档什么都不显示，
//                                   用户只能得出「按钮坏了」）
//      · 点过，它正常跑完了，终态过了 10 分钟被清掉 → 说「重启」就是撒谎（第 2 轮审查复现：
//                                   页面关着的时候跑完，十分钟后回来看到一句从没发生的重启）
//
// 分开这三种要两样东西：本地记着的作业身份，以及**服务端自报的实例身份**（ASSIST_INSTANCE，
// 每次 ash 启动换一个）。实例没变 = 这台 ash 没重启过 = 那条记录是自己过期的。
import type { PreviewAssistState } from "@ash/shared/preview-assist";

const EXECUTOR_KEY = (projectId: string) => `ash:preview-assist-executor:${projectId}`;
const LIVE_KEY = (projectId: string) => `ash:preview-assist-live:${projectId}`;

/** localStorage 在隐私模式下会抛，这一整套都是「有就用、没有就算了」。 */
function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null): void {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* 隐私模式 */ }
}

export const rememberedExecutor = (projectId: string): string => read(EXECUTOR_KEY(projectId)) ?? "";
export const rememberExecutor = (projectId: string, value: string): void =>
  write(EXECUTOR_KEY(projectId), value || null);

export interface AssistTrace {
  /** 服务端认下来的作业 id；空串 = 请求发出去了但结果没回来（见 pendingAssistTrace）。 */
  jobId: string;
  executorLabel: string;
  round: number;
  maxRounds: number;
  startedAt: string;
  /** 点下去的那一刻，回话的是哪一台 ash。 */
  instance: string;
}

export function readAssistTrace(projectId: string): AssistTrace | null {
  const raw = read(LIVE_KEY(projectId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AssistTrace;
    return typeof parsed?.jobId === "string" ? parsed : null;
  } catch { return null; }
}

/**
 * **请求发出去之前**就先记一笔。
 *
 * 服务端是同步预占的（preview-assist-jobs.ts），所以「浏览器没拿到返回」跟「服务端没接单」
 * 完全是两回事：第 2 轮审查把 POST 的响应掐掉，服务端那边智能体已经在跑了，而页面上什么
 * 都没有——按钮弹回原样，停也停不了，之后 ash 一重启更是连一句交代都没有。先写后发，这条
 * 记录才覆盖得住「请求在路上出事」的那一段。
 */
export function pendingAssistTrace(projectId: string, instance: string): void {
  write(LIVE_KEY(projectId), JSON.stringify({
    jobId: "", executorLabel: "", round: 0, maxRounds: 3, startedAt: new Date().toISOString(), instance,
  } satisfies AssistTrace));
}

/** 作业还在跑：把身份记住（每一拍都写，轮次跟着走，中断那句话才说得出第几轮）。 */
export function traceAssistJob(projectId: string, job: PreviewAssistState, instance: string): void {
  write(LIVE_KEY(projectId), JSON.stringify({
    jobId: job.jobId,
    executorLabel: job.executorLabel,
    round: job.round,
    maxRounds: job.maxRounds,
    startedAt: job.startedAt,
    instance,
  } satisfies AssistTrace));
}

export const forgetAssistTrace = (projectId: string): void => write(LIVE_KEY(projectId), null);

/**
 * 服务端回了 `job: null`，而本地这条记录还在：把它摆成一张卡交给进度面板渲染。
 *
 * 用 `failed` 这一档是有意的：两种情况都确实没跑完、也确实没有可填的脚本，界面该是「出事了」
 * 那个调子而不是灰掉一行。话要说准 —— 用户下一步要决定的是「再点一次」还是「自己手写」，
 * 而**把过期说成重启会让他去查一台根本没重启过的 ash**。
 */
export function lostAssistState(
  projectId: string,
  trace: AssistTrace,
  /** 现在回话的这台 ash 还是不是当初那台。 */
  sameInstance: boolean,
): PreviewAssistState {
  const at = trace.round > 0 ? `第 ${trace.round} 轮` : "刚开工";
  const pending = !trace.jobId;
  const step = sameInstance ? (pending ? "没收到启动结果" : "上一次的结果已经过期") : "已随 ash 重启中断";
  const error = !sameInstance
    ? `上一次的 AI 协助跑到${at}时 ash 重启了，进度没能留下来（它是内存态的）。要继续就再点一次「AI 协助填写」。`
    : pending
      ? "上一次点「AI 协助填写」时没收到服务端的回复，现在这个项目上也没有在跑的协助 —— 那一次多半没开起来。要继续就再点一次。"
      : `上一次的 AI 协助在你没看着的时候结束了，结果只保留 10 分钟、现在已经取不回来了（它跑到${at}）。要拿脚本就再点一次「AI 协助填写」。`;
  return {
    jobId: trace.jobId || "pending",
    projectId,
    status: "failed",
    phase: "done",
    round: trace.round,
    maxRounds: trace.maxRounds,
    executorLabel: trace.executorLabel,
    step,
    say: "",
    attempts: [],
    script: null,
    url: null,
    error,
    startedAt: trace.startedAt,
    endedAt: null,
  };
}
