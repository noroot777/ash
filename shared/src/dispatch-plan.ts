// 派活单：智能体想派出一批任务时先摆给用户看（MCP `propose_dispatch`），用户在回复框那一格换人、
// 去掉某条、定一个接一个还是同时，按「派出去」由 navi 照卡上此刻的样子建任务（server/src/dispatch-plan*.ts）。
//
// 它借的是提问那一套停法：摆出来时同时写下 `task.question`（一句能直接读的清单），结算落暂停、队列
// 不自动续跑、刷新后还在，别的端（手机、飞书）不认识这张卡也照样看得出它在等什么、能用一句话回。
// 所以派活单只在「那一问还是它」的时候算数（`activeDispatchPlan`）：提问被答掉、被新消息撤下、
// 被新的提问换掉，它就跟着作废，不必在每一处清提问的地方另清一遍。
import type { AgentType } from "./index.ts";
import type { CreateReviewChoice } from "./review-on-create.ts";

export type DispatchOrder = "serial" | "parallel";

/** 交给谁：智能体 · 模型 · 智能水平（同回复框那颗三段胶囊）。 */
export type DispatchRunTarget = {
  agentType: AgentType;
  executorId: string | null;
  /** null = 跟随执行器 */
  model: string | null;
  /** null = 跟随执行器 */
  reasoningEffort: string | null;
};

export type DispatchPlanItem = {
  /** 同一批里的本地标识，`prerequisites` 用它指这一条。 */
  key?: string;
  title: string;
  /** 完整说明：建出来的任务正文就是它。 */
  body: string;
  /** 卡上标题下面那一行小字。 */
  note: string;
  /** 智能体指明了交给谁；null = 用这条任务「派出去的活交给谁」的默认值。 */
  target: DispatchRunTarget | null;
  /** 谁来审（review-on-create.ts）；缺省 = 默认审查者（这一项上线前摆的单同样按默认）。 */
  review?: CreateReviewChoice;
  useWorktree?: boolean;
  worktreeBase?: string | null;
  mergeTargetBranch?: string | null;
  labels?: string[];
  prerequisites?: string[];
};

/**
 * 派出去之后这条任务还有没有智能体的事，摆单时由智能体说定：
 *   · done：派出去就是这条任务的最后一步。按下「派出去」那一下由 Navi 把这条任务结成完成、不叫醒它——
 *     摆单那一刻它已经替这一下确认过了；建好的清单留到它下一回合开头再交给它（问答记录的 `undelivered`）。
 *   · continue：派出去之后还要接着做，照旧把清单作为答复续上它的会话。
 */
export type DispatchAfterLaunch = "done" | "continue";

export type DispatchPlan = {
  id: string;
  /** 跟它绑在一起的那一问（`task.question` 的原文）。 */
  question: string;
  order: DispatchOrder;
  items: DispatchPlanItem[];
  /** 缺省 = continue：这一项上线前摆的单，摆单的智能体是按「会被叫醒」写的。 */
  afterLaunch?: DispatchAfterLaunch;
  proposedAt: string;
};

/** 按「派出去」时卡上此刻的样子：留下的几行（按卡上的顺序）、各交给谁、一个接一个还是同时。 */
export type DispatchLaunchInput = {
  planId: string;
  order: DispatchOrder;
  /** review 缺省 = 照单子上那一格（再缺省就是默认审查者）。 */
  items: { index: number; target: DispatchRunTarget; review?: CreateReviewChoice }[];
};

export const MAX_DISPATCH_PLAN_ITEMS = 12;
export const MAX_DISPATCH_NOTE_LEN = 120;

export const DISPATCH_ORDER_LABEL: Record<DispatchOrder, string> = { serial: "一个接一个", parallel: "同时" };

/**
 * 「派出去」续上智能体会话的那段答复（server dispatch-plan.ts `launchReply`）以它开头。那段话只是交给智能体的
 * 回执：用户在会话里看到的是每条新任务各一句「开了新任务」（web dispatchNotes.ts，跟回复框、建议栏派出去
 * 同一种），所以会话里认出这段答复就不再画成一颗「你」的气泡——否则同一下要说两遍，气泡里还把整张清单引一遍。
 */
export const DISPATCH_LAUNCH_REPLY_LEAD = "用户按了「派出去」：";

export function isDispatchLaunchReply(text: string): boolean {
  return text.trimStart().replace(/^【答复】\s*/, "").startsWith(DISPATCH_LAUNCH_REPLY_LEAD);
}

/** 派活单还算不算数：那一问还是它。 */
export function activeDispatchPlan(task: { question?: string | null; dispatchPlan?: DispatchPlan | null }): DispatchPlan | null {
  const plan = task.dispatchPlan;
  return plan && task.question && plan.question === task.question ? plan : null;
}

/**
 * 「派出去的活交给谁」此刻落在谁身上：设了就是设的那个，没设（同这里）就是这条任务自己的执行器。
 * 这条任务自己也没定执行器时给 null，由调用方按各自的默认口径接手。
 */
export function dispatchDefaultTarget(task: {
  dispatchTarget?: DispatchRunTarget | null;
  agentType?: AgentType | null;
  executorId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}): DispatchRunTarget | null {
  if (task.dispatchTarget) return task.dispatchTarget;
  if (!task.agentType) return null;
  return {
    agentType: task.agentType,
    executorId: task.executorId ?? null,
    model: task.model ?? null,
    reasoningEffort: task.reasoningEffort ?? null,
  };
}

/** 存在任务上的那一份（JSON 列）读回来；形状不对当没有。 */
export function parseDispatchTarget(raw: string | null | undefined): DispatchRunTarget | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<DispatchRunTarget>;
    if (!value || typeof value.agentType !== "string") return null;
    return {
      agentType: value.agentType,
      executorId: typeof value.executorId === "string" ? value.executorId : null,
      model: typeof value.model === "string" && value.model ? value.model : null,
      reasoningEffort: typeof value.reasoningEffort === "string" && value.reasoningEffort ? value.reasoningEffort : null,
    };
  } catch {
    return null;
  }
}

export function parseDispatchPlan(raw: string | null | undefined): DispatchPlan | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as DispatchPlan;
    return value && typeof value.id === "string" && Array.isArray(value.items) ? value : null;
  } catch {
    return null;
  }
}
