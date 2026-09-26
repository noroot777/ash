// 「AI 协助」在浏览器本地记的两件事。
//
// ① 选了谁来判断 —— 一次性的选择，记在本地按项目记就够，不进库（它不像任务的执行器那样
//    要被别人、被重启后的服务端读到）。
// ② **这个浏览器点过的那个作业** —— 服务端的进度是内存态（server/src/preview-assist.ts 说了
//    为什么不落库），ash 一重启就没了，GET 回来的是 `job: null`。光看这个 null 分不清两件
//    事：「从来没点过」和「点过、结果被重启吞了」。第 1 轮审查复现的正是后者：面板悄悄退回
//    初始按钮，用户只能得出「这颗按钮没生效」。
//
// 所以点过的那一刻就把作业身份记在本地，轮询突然拿到 null 时由它推出「已随 ash 重启中断」，
// 并且**刷新之后还在**（项目约定：停止/中断必须留下持久可见的状态，判据就是刷新后还看得见）。
// 作业正常跑完（成功/失败/取消）时这条记录当场删掉 —— 否则 10 分钟后服务端把终态清掉，
// 同一个 null 会被误读成「中断」。
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
  jobId: string;
  executorLabel: string;
  round: number;
  maxRounds: number;
  startedAt: string;
  /** 已经确认是被重启吞掉的了（推导只做一次，之后照这条显示）。 */
  interrupted?: boolean;
}

export function readAssistTrace(projectId: string): AssistTrace | null {
  const raw = read(LIVE_KEY(projectId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AssistTrace;
    return typeof parsed?.jobId === "string" ? parsed : null;
  } catch { return null; }
}

/** 作业还在跑：把身份记住（每一拍都写，轮次跟着走，中断那句话才说得出第几轮）。 */
export function traceAssistJob(projectId: string, job: PreviewAssistState): void {
  write(LIVE_KEY(projectId), JSON.stringify({
    jobId: job.jobId,
    executorLabel: job.executorLabel,
    round: job.round,
    maxRounds: job.maxRounds,
    startedAt: job.startedAt,
  } satisfies AssistTrace));
}

export const forgetAssistTrace = (projectId: string): void => write(LIVE_KEY(projectId), null);

export function markAssistInterrupted(projectId: string, trace: AssistTrace): void {
  write(LIVE_KEY(projectId), JSON.stringify({ ...trace, interrupted: true } satisfies AssistTrace));
}

/**
 * 把本地那条记录摆成一个「中断」的作业状态，交给进度面板照常渲染。
 *
 * 用 `failed` 这一档是有意的：它确实没跑完，也确实没有可填的脚本，界面该是「出事了」那个
 * 调子而不是灰掉一行。话说清楚它中断在第几轮 —— 用户下一步要决定的是「再点一次」还是
 * 「自己手写」，而这取决于它之前跑到哪儿了。
 */
export function interruptedAssistState(projectId: string, trace: AssistTrace): PreviewAssistState {
  const at = trace.round > 0 ? `第 ${trace.round} 轮` : "刚开工";
  return {
    jobId: trace.jobId,
    projectId,
    status: "failed",
    phase: "done",
    round: trace.round,
    maxRounds: trace.maxRounds,
    executorLabel: trace.executorLabel,
    step: "已随 ash 重启中断",
    say: "",
    attempts: [],
    script: null,
    url: null,
    error: `上一次的 AI 协助跑到${at}时 ash 重启了，进度没能留下来（它是内存态的）。要继续就再点一次「AI 协助填写」。`,
    startedAt: trace.startedAt,
    endedAt: null,
  };
}
