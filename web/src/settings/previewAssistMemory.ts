// 「AI 协助」在浏览器本地记的两件事。**它们的存储范围不一样，这一点是硬要求**：
//
// ① 选了谁来判断 —— 按项目记在 `localStorage`，整个浏览器共享（一次性的选择，不进库：它不像
//    任务的执行器那样要被别人、被重启后的服务端读到）。
// ② **这个页面点过的那个作业** —— 记在 `sessionStorage`，**按标签页隔离**。放 localStorage 就
//    等于把所有权凭据摊给同源的每一个标签：同一项目开着的另一个页面（从没点过按钮）会读到
//    这条记录、把服务端那份作业认成自己的，于是在成功时把**它自己**输入框里的草稿改掉
//    （第 6 轮审查双标签复现）。sessionStorage 正好是「刷新还在、别的标签读不到」。
//    **但它挡不住会话副本**：带 opener 打开的页面和「复制标签页」会继承来源页那一份的初始
//    副本，两边 claim 一模一样（第 7 轮审查复现）。所以页面打开时还要过一道所有权裁决 ——
//    见 adoptAssistTrace 与 previewAssistTabs.ts（那里用的是浏览器自己记账的页面租约，
//    「正主卡住」和「正主已经消失」靠它才分得开）。
//    代价说清楚：整个标签页关掉再开，新标签确实没有任何证据说明「我点过」，那三句交代
//    （见下）就给不出来了 —— 这是对的，一个刚开的上下文本来就不该去认领谁的作业。
//
// 服务端的进度是内存态（server/src/preview-assist.ts 说了
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
import { claimAssistOwnership, holdAssistClaim } from "./previewAssistTabs.ts";

const EXECUTOR_KEY = (projectId: string) => `ash:preview-assist-executor:${projectId}`;
const LIVE_KEY = (projectId: string) => `ash:preview-assist-live:${projectId}`;

/** 两种存储在隐私模式下都会抛，这一整套都是「有就用、没有就算了」。 */
function get(store: Storage | undefined, key: string): string | null {
  try { return store?.getItem(key) ?? null; } catch { return null; }
}
function set(store: Storage | undefined, key: string, value: string | null): void {
  try { value === null ? store?.removeItem(key) : store?.setItem(key, value); } catch { /* 隐私模式 */ }
}
/** 整个浏览器共享的那一份（执行器偏好）。 */
const read = (key: string): string | null => get(globalThis.localStorage, key);
const write = (key: string, value: string | null): void => set(globalThis.localStorage, key, value);
/** **只属于这个标签页**的那一份（作业所有权）。见文件顶部为什么必须分开。 */
const readLive = (key: string): string | null => get(globalThis.sessionStorage, key);
function writeLive(key: string, value: string | null): void {
  set(globalThis.sessionStorage, key, value);
  // 这条记录在 2026-09-27 之前存在 localStorage 里。留着的话，那台浏览器上每个同源标签都还
  // 认着一份旧凭据，所以顺手把它清掉（只清这一个键，执行器偏好照旧住在 localStorage）。
  write(key, null);
}

export const rememberedExecutor = (projectId: string): string => read(EXECUTOR_KEY(projectId)) ?? "";
export const rememberExecutor = (projectId: string, value: string): void =>
  write(EXECUTOR_KEY(projectId), value || null);

/**
 * 给这一次点击发一个身份。服务端只把它存进**新建**的那份作业，所以「作业上的 claim 等于我
 * 手里这个」是唯一靠得住的所有权证据（见 AssistTrace.claim）。
 *
 * `crypto.randomUUID` 在非安全上下文里可能没有（ash 常走裸 http 的局域网地址），退一步用
 * 时间 + 随机串 —— 这东西只要在同一个项目的几份作业之间不撞就够了。
 */
export const newAssistClaim = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export interface AssistTrace {
  /** 服务端认下来的作业 id；空串 = 请求发出去了但结果没回来（见 pendingAssistTrace）。 */
  jobId: string;
  /**
   * 点下去那一刻这个页面自报的身份。**认领作业只认它**：服务端只把它存进新建的那一份，
   * 撞上已经在跑的作业时原样交回原主的 claim，所以一比就知道「这不是我点出来的」
   * （第 5 轮审查：原来空 jobId 的 pending 记录会认领任意作业，别人的结果照样覆盖输入框）。
   */
  claim: string;
  executorLabel: string;
  round: number;
  maxRounds: number;
  startedAt: string;
  /** 点下去的那一刻，回话的是哪一台 ash。 */
  instance: string;
}

export function readAssistTrace(projectId: string): AssistTrace | null {
  const raw = readLive(LIVE_KEY(projectId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AssistTrace;
    if (typeof parsed?.jobId !== "string") return null;
    return parsed;
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
export function pendingAssistTrace(projectId: string, instance: string, claim: string): void {
  writeLive(LIVE_KEY(projectId), JSON.stringify({
    jobId: "", claim, executorLabel: "", round: 0, maxRounds: 3,
    startedAt: new Date().toISOString(), instance,
  } satisfies AssistTrace));
  holdAssistClaim(projectId, claim, "click");
}

/** 作业还在跑：把身份记住（每一拍都写，轮次跟着走，中断那句话才说得出第几轮）。 */
export function traceAssistJob(projectId: string, job: PreviewAssistState, instance: string): void {
  writeLive(LIVE_KEY(projectId), JSON.stringify({
    jobId: job.jobId,
    // 调用方只在「这份确实是我点的」时才写（PreviewAiAssist 的 absorb），所以这儿的 claim
    // 就是我们自己那个；从作业上读省得再传一遍。
    claim: job.claim,
    executorLabel: job.executorLabel,
    round: job.round,
    maxRounds: job.maxRounds,
    startedAt: job.startedAt,
    instance,
  } satisfies AssistTrace));
  // 兜底：走到这儿时登记早就有了（点击时、或页面打开裁决完时就登记过）。真要是没有，也只当最弱
  // 那一档 —— 不可逆的动作宁可少做（见 previewAssistTabs.ts 的 assistClaimSettled）。
  holdAssistClaim(projectId, job.claim, "provisional");
}

export const forgetAssistTrace = (projectId: string): void => {
  writeLive(LIVE_KEY(projectId), null);
  holdAssistClaim(projectId, null);
};

/**
 * 页面刚打开时先确认手里这条记录**不是会话副本**，确认完才允许拿它去认领作业。
 *
 * 副本从哪来、为什么只能靠「同一时刻还有没有另一个活着的文档拿着它」分辨（以及为什么这件事
 * 不能靠问一句、等一会儿），见 previewAssistTabs.ts。确认是自己的那一刻就把 claim 握住 ——
 * 之后从这一页复制出去的标签才会当场知道自己是副本。
 *
 * 必须**排在第一次轮询前面**：颠倒过来的话，抢在前面那一拍就已经把别人那份认成自己的了。
 * 所有权也可能**事后被撤回**（降级路上的迟到应答），那一路走 watchAssistClaimLost。
 */
export async function adoptAssistTrace(projectId: string): Promise<void> {
  const trace = readAssistTrace(projectId);
  if (!trace?.claim) return;
  if (!await claimAssistOwnership(projectId, trace.claim)) forgetAssistTrace(projectId);
}

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
    claim: trace.claim,
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
