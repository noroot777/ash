import type { AgentType, Task } from "@ash/shared";
import type { DockChoice } from "./ReplyDock.tsx";
import type { MentionTarget } from "./mentionPicker.ts";
import { sourceWorktreeBranch } from "./taskDerivation.ts";

/**
 * 回复框里 `@` 了一个人：叫谁、来做什么、（派出去时）从哪开工。纯逻辑，组件与回归都从这里取。
 *
 * - 问一句：现在就有的一次性召唤——这一条消息由它在这条任务里答，下一条回到原来的执行器；
 * - 派出去：开一条新任务交给它，带着这场对话到此为止的背景，挂在这条任务名下（dispatchedBy）。
 *   这条任务的智能体不被叫醒、不占回合，所以它在跑时也能派。
 *
 * 做法排成框顶一行（ReplyCallDock.tsx），选完人默认停在「问一句」。「讨论」以后插在两颗中间，
 * 加一个 verb、一份文案即可。
 */
export type CallVerb = "ask" | "dispatch";
export const CALL_VERBS: readonly CallVerb[] = ["ask", "dispatch"];

/** 派出去的新任务从哪开工：接着这条任务的代码 / 从主分支开工。 */
export type DispatchBase = "here" | "trunk";

export type ReplyCall = { target: MentionTarget; verb: CallVerb; base: DispatchBase };

export const CALL_COPY: Record<CallVerb, {
  label: string;
  tip: string;
  send: (who: string) => string;
  placeholder: (who: string) => string;
}> = {
  ask: {
    label: "问一句",
    tip: "它在这场对话里答这一句，下一句还是这条任务原来的执行器接着跑。",
    send: (who) => `问 ${who}`,
    placeholder: (who) => `问 ${who}…`,
  },
  dispatch: {
    label: "派出去",
    tip: "开一条新任务交给它，带着这场对话到此为止的背景。这条任务照常跑；新任务自己审查、自己验收，在「派出的任务」里看。",
    send: () => "派出去",
    placeholder: () => "交代清楚要做成什么样…",
  },
};

/** `@` 的是这条任务自己的执行器（同一种执行器在这条任务里续同一条会话，问它就是直接写）。 */
export const SELF_ASK_HELD = "它就是这条任务自己的执行器：直接写就是问它。叫它来只能派一条新任务";

export function isSelfCall(agent: AgentType, ownAgent: AgentType): boolean {
  return agent === ownAgent;
}

/** 叫上一个人时停在哪一种：自己只有「派出去」；明说了要派（`/派`）就派；其余默认「问一句」。 */
export function initialVerb(self: boolean, prefer: CallVerb | null, dispatchable: boolean): CallVerb {
  if (!dispatchable) return "ask";
  if (self) return "dispatch";
  return prefer ?? "ask";
}

/** 框顶那一行的几颗。派不出去的地方（团队执行者、审查任务）这一行不出：只有一种做法就不必摆。 */
export function callChoices(self: boolean, dispatchable: boolean): DockChoice<CallVerb>[] {
  if (!dispatchable) return [];
  return CALL_VERBS.map((verb) => ({
    id: verb,
    label: CALL_COPY[verb].label,
    tip: CALL_COPY[verb].tip,
    held: verb === "ask" && self ? SELF_ASK_HELD : null,
  }));
}

// —— 派出去的新任务从哪开工（胶囊最后那一段）——
export type BaseContext = {
  isRepo: boolean;
  branches: string[];
  /** 项目目录此刻检出的分支。 */
  current: string | null;
  /** 新任务默认开不开 worktree（projects.useWorktreeDefault）。 */
  worktreeDefault: boolean;
};
export type BaseOption = { id: DispatchBase; label: string; worktreeBase: string | null };

/**
 * 两种开工起点各落成哪个 `worktreeBase`：
 * - 接着这里的代码：这条任务有自己的分支就从它开（服务端冻结那一刻的提交、记下验收依赖）；
 *   它就在项目目录里干活，就是项目目录此刻的 HEAD（null）；
 * - 从主分支开工：这条任务最终合进去的那条分支，没定就是项目目录检出的那条。
 * 新任务不开 worktree（不是仓库、项目默认关）时无从选，两种落到同一处时也不必选：都返回空，那一段不出。
 * 这条任务的分支已经没了，「接着这里」无从说起，同样不出，按默认从 HEAD 开。
 */
export function dispatchBaseOptions(
  task: Pick<Task, "id" | "useWorktree" | "mergeTargetBranch">,
  context: BaseContext | null,
): BaseOption[] {
  if (!context?.isRepo || !context.worktreeDefault) return [];
  const source = sourceWorktreeBranch(task);
  if (source && !context.branches.includes(source)) return [];
  const trunk = task.mergeTargetBranch?.trim() || context.current;
  if (!trunk || !context.branches.includes(trunk)) return [];
  if (!source && context.current === trunk) return [];
  return [
    { id: "here", label: "接着这里的代码", worktreeBase: source },
    { id: "trunk", label: `从 ${trunk} 开工`, worktreeBase: trunk },
  ];
}

// —— `/派`：叫上次那个人，停在「派出去」 ——
export const DISPATCH_COMMAND = "/派";
const DISPATCH_TEXT = /^\/派(?:\s+|$)/u;
export const DISPATCH_SLASH_ITEM = { command: DISPATCH_COMMAND, label: "派出去", hint: "开一条新任务交给上次叫的人" };

/** 正文以 `/派` 开头：返回它后面那段（要交代的话），否则 null。 */
export function parseDispatchCommand(text: string): string | null {
  const trimmed = text.trimStart();
  const match = DISPATCH_TEXT.exec(trimmed);
  return match ? trimmed.slice(match[0].length) : null;
}

// —— 记住上次叫的是谁、对每个人用的模型和智能水平（整个浏览器共享，不进库）——
type Remembered = Pick<MentionTarget, "executorId" | "model" | "reasoningEffort">;
export type CallMemory = { last: AgentType | null; byAgent: Partial<Record<AgentType, Remembered>> };

const MEMORY_KEY = "ash:reply-call";
const EMPTY: CallMemory = { last: null, byAgent: {} };

export function readCallMemory(): CallMemory {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(MEMORY_KEY) ?? "null") as Partial<CallMemory> | null;
    if (!parsed || typeof parsed !== "object") return EMPTY;
    return {
      last: typeof parsed.last === "string" ? parsed.last as AgentType : null,
      byAgent: parsed.byAgent && typeof parsed.byAgent === "object" ? parsed.byAgent : {},
    };
  } catch {
    return EMPTY;
  }
}

export function rememberCall(target: MentionTarget): void {
  const memory = readCallMemory();
  const next: CallMemory = {
    last: target.agent,
    byAgent: {
      ...memory.byAgent,
      [target.agent]: { executorId: target.executorId, model: target.model, reasoningEffort: target.reasoningEffort },
    },
  };
  try { globalThis.localStorage?.setItem(MEMORY_KEY, JSON.stringify(next)); } catch { /* 隐私模式：记不住就算了 */ }
}

/** 叫上他时胶囊上先摆什么：上次对他用的那一套；没有就跟随这个执行器的默认。 */
export function rememberedTarget(agent: AgentType, memory: CallMemory = readCallMemory()): MentionTarget {
  const kept = memory.byAgent[agent];
  return {
    agent,
    executorId: typeof kept?.executorId === "string" ? kept.executorId : null,
    model: typeof kept?.model === "string" ? kept.model : null,
    reasoningEffort: typeof kept?.reasoningEffort === "string" ? kept.reasoningEffort : null,
  };
}
