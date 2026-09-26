// 「AI 协助」：让一个真的 CLI 智能体去项目里判断该怎么起预览，**由 ash 自己真跑一遍**，
// 跑起来了才把脚本填回输入框。
//
// 这件事分工很明确，两边都不越界：
//   · 智能体负责「判别」—— 它读得懂 README、认得出 monorepo 里哪个才是要看的那个前端、
//     知道这个框架的端口要写成参数还是读环境变量。这些是静态检测（preview-command.ts）
//     永远做不到的。
//   · ash 负责「判定」—— 借一个真端口、在项目目录里把脚本真跑起来、探端口上有没有响应、
//     然后杀干净（preview-trial.ts）。模型说「我验证过了」不作数：它可能在别的端口上验的、
//     可能把 build 当成了 serve、也可能压根没跑。
// 起不来就把失败原因和日志尾巴甩回给它再来一轮，最多 PREVIEW_ASSIST_MAX_ROUNDS 轮。
//
// 进度是**内存态**：一个项目同时只有一个 job，server 重启就没了（前端轮询拿到 null 会说
// 一句「已随 ash 重启中断」）。不落库是有意的 —— 它是一次几分钟的交互式动作，不是任务，
// 落库只会多出一张要清理的表和一堆「上次那个还挂在那儿」的僵尸状态。
import {
  parseAssistScript,
  PREVIEW_ASSIST_MAX_ROUNDS,
  PREVIEW_ASSIST_THINK_MS,
  PREVIEW_ASSIST_TRIAL_MS,
  type PreviewAssistAttempt,
  type PreviewAssistState,
} from "@ash/shared/preview-assist";
import type { PreviewMode } from "@ash/shared/preview";
import type { AgentType } from "@ash/shared";
import { runEnvForOwner } from "./auth/run-env.js";
import { withGlobalBrowserPolicy } from "./browser-verification-policy.js";
import { resolveExecutorFor } from "./executors/index.js";
import type { RunHandle } from "./executors/types.js";
import { assistOpeningPrompt, assistRetryPrompt } from "./preview-assist-prompt.js";
import { trialPreviewScript } from "./preview-trial.js";
import { id, now } from "./util.js";

export interface PreviewAssistStartOptions {
  projectId: string;
  /** 项目目录（已展开 `~`）。智能体和试跑都在这里干活。 */
  cwd: string;
  mode: PreviewMode;
  /** 输入框里现在填着什么，给智能体当参考。 */
  currentScript: string;
  executorId?: string | null;
  agentType?: AgentType | null;
  model?: string | null;
  reasoningEffort?: string | null;
  /** 用谁的执行器跑（多人模式，§八）。 */
  owner?: string | null;
}

interface Job {
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

/** 用户点了取消。返回 false = 本来就没有在跑的。 */
export function cancelPreviewAssist(projectId: string): boolean {
  const job = jobs.get(projectId);
  if (!job || job.state.status !== "running") return false;
  job.canceled = true;
  try { job.handle?.kill(); } catch { /* 已经退了 */ }
  finish(job, "canceled", "已取消");
  return true;
}

export async function startPreviewAssist(options: PreviewAssistStartOptions): Promise<PreviewAssistState> {
  const running = jobs.get(options.projectId);
  if (running?.state.status === "running") return running.state;
  const executor = await resolveExecutorFor({
    executorId: options.executorId ?? null,
    type: options.agentType ?? null,
    model: options.model ?? null,
    reasoningEffort: options.reasoningEffort ?? null,
    owner: options.owner,
  });
  const job: Job = {
    canceled: false,
    handle: null,
    state: {
      jobId: id(),
      projectId: options.projectId,
      status: "running",
      phase: "starting",
      round: 0,
      maxRounds: PREVIEW_ASSIST_MAX_ROUNDS,
      executorLabel: executor.label,
      step: `${executor.label} 准备开工…`,
      say: "",
      attempts: [],
      script: null,
      url: null,
      error: null,
      startedAt: now(),
      endedAt: null,
    },
  };
  jobs.set(options.projectId, job);
  const runEnv = await runEnvForOwner(options.owner ?? null, executor.type);
  void loop(job, options, executor, runEnv).catch((error) => {
    finish(job, "failed", error instanceof Error ? error.message : String(error));
  });
  return job.state;
}

type Executor = Awaited<ReturnType<typeof resolveExecutorFor>>;

async function loop(
  job: Job,
  options: PreviewAssistStartOptions,
  executor: Executor,
  runEnv: Record<string, string | undefined>,
): Promise<void> {
  let cliSession: string | undefined;
  let last: PreviewAssistAttempt | null = null;
  // 连着两轮拿不到脚本 = 它多半是在说「这个项目起不来」，而不是格式写歪了。再问一遍只是
  // 多花两分钟换同一句话，不如当场把它的原话交给用户（那句话本身就是答案）。
  let noScript = 0;
  for (let round = 1; round <= PREVIEW_ASSIST_MAX_ROUNDS; round += 1) {
    if (job.canceled) return;
    job.state.round = round;
    job.state.phase = "thinking";
    job.state.step = round === 1
      ? `第 ${round} 轮：${executor.label} 正在读这个项目，判断该怎么起`
      : `第 ${round} 轮：${executor.label} 正在按上一轮的失败原因修正`;
    const prompt = round === 1
      ? assistOpeningPrompt({ repoPath: options.cwd, mode: options.mode, currentScript: options.currentScript })
      : retryPrompt(last, round);
    const said = await think(job, executor, options.cwd, prompt, cliSession, runEnv);
    if (job.canceled) return;
    cliSession = said.sessionId ?? cliSession;
    if (said.error && !said.text.trim()) {
      last = { round, script: "", ok: false, url: null, reason: said.error, log: "" };
      job.state.attempts = [...job.state.attempts, last];
      continue;
    }
    const script = parseAssistScript(said.text);
    if (!script) {
      noScript += 1;
      last = {
        round, script: "", ok: false, url: null, log: "",
        reason: "它没有给出可用的启动脚本（可能是判断这个项目起不来，见它自己的说明）",
      };
      job.state.attempts = [...job.state.attempts, last];
      if (noScript >= 2) {
        finish(job, "failed", `${executor.label} 连着两轮都没给出可用的启动脚本，多半是它认为这个项目起不来。它最后说的是：\n${job.state.say}`);
        return;
      }
      continue;
    }
    noScript = 0;
    job.state.phase = "trying";
    job.state.step = `第 ${round} 轮：ash 正在借一个空闲端口，照这条脚本真跑一遍`;
    const attempt: PreviewAssistAttempt = { round, script, ok: false, url: null, reason: null, log: "" };
    job.state.attempts = [...job.state.attempts, attempt];
    const outcome = await trialPreviewScript({
      cwd: options.cwd,
      script,
      mode: options.mode,
      timeoutMs: PREVIEW_ASSIST_TRIAL_MS,
      canceled: () => job.canceled,
      onLog: (log) => { attempt.log = log.slice(-4000); },
    });
    if (job.canceled) return;
    Object.assign(attempt, { ok: outcome.ok, url: outcome.url, reason: outcome.reason, log: outcome.log.slice(-4000) });
    last = attempt;
    if (outcome.ok) {
      job.state.script = script;
      job.state.url = outcome.url;
      finish(job, "succeeded", null);
      return;
    }
  }
  finish(job, "failed", `试了 ${PREVIEW_ASSIST_MAX_ROUNDS} 轮都没能真的起起来${last?.reason ? `。最后一次：${last.reason}` : ""}`);
}

function retryPrompt(last: PreviewAssistAttempt | null, round: number): string {
  if (!last) return "请按原格式给出启动脚本。";
  if (!last.script) {
    // 别逼它硬凑一条：这条岔路的常见成因是「它认为这个项目起不来」，而催出来的那条命令
    // ash 照样会真跑一遍（白烧两分钟）再告诉用户同一件事。
    return `上一轮没收到可用的结论（${last.reason ?? "没给出脚本"}）。如果你确实找到了启动方式，请按格式给结论：一行「启动脚本：」，紧跟一个 \`\`\`sh 围栏块，块里只放脚本本身（不要粘终端回显）。如果你的判断是这个项目根本起不来，就把原因说清楚、不要写那一段 —— 我会把你的原话原样转给用户。`;
  }
  return assistRetryPrompt({
    script: last.script,
    reason: last.reason ?? "未知原因",
    log: last.log,
    round,
    maxRounds: PREVIEW_ASSIST_MAX_ROUNDS,
  });
}

/** 跑一个智能体回合，把它说的话收回来。超时/报错都不抛，交给调用方当成「这一轮没成」。 */
async function think(
  job: Job,
  executor: Executor,
  cwd: string,
  prompt: string,
  sessionId: string | undefined,
  runEnv: Record<string, string | undefined>,
): Promise<{ text: string; sessionId: string | null; error: string | null }> {
  let handle: RunHandle | null = null;
  let text = "";
  let error: string | null = null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { handle?.kill(); } catch { /* 已经退了 */ }
  }, PREVIEW_ASSIST_THINK_MS);
  try {
    handle = executor.run({
      prompt: withGlobalBrowserPolicy(prompt, sessionId ? "reminder" : "full"),
      cwd,
      sessionId,
      // 这不是一个任务回合：完成协议的那三个变量一个都不能有。不显式清掉的话，子进程会从
      // server 自己的环境里继承到**别的任务**的身份（duet 那边实测过），借来的身份比没有
      // 身份更糟 —— 它能拿着去调 complete_task。
      env: { ...runEnv, ASH_TASK_ID: undefined, ASH_TURN_TOKEN: undefined, ASH_DIRECTION_TOKEN: undefined },
    });
    job.handle = handle;
    for await (const event of handle.events) {
      if (job.canceled) break;
      if (event.kind === "text") {
        text += event.text;
        job.state.say = text.slice(-800);
      } else if (event.kind === "tool") {
        job.state.step = `${job.state.step.split("｜")[0]!.trimEnd()}｜正在用 ${event.name}`;
      } else if (event.kind === "error" && event.level !== "notice") {
        error ??= event.message;
      }
      if (text.length > 200_000) break;
    }
  } catch (failure) {
    error ??= failure instanceof Error ? failure.message : String(failure);
  } finally {
    clearTimeout(timer);
    try { handle?.kill(); } catch { /* 已经退了 */ }
    try { await handle?.cleanup?.(); } catch { /* 清理失败不该拖垮这一轮 */ }
    job.handle = null;
  }
  if (timedOut) error ??= `这一轮超过 ${Math.round(PREVIEW_ASSIST_THINK_MS / 60_000)} 分钟还没给结论，已中止`;
  return { text, sessionId: handle?.sessionId ?? null, error };
}

function finish(job: Job, status: PreviewAssistState["status"], error: string | null): void {
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
