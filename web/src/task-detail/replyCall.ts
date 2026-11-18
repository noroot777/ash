import type { AgentType, DiscussionRounds, Task } from "@ash/shared";
import type { CreateReviewChoice } from "@ash/shared/review-on-create";
import { DISCUSSION_ROUND_CHOICES, MAX_DISCUSSION_GUESTS, discussionRoundsOf } from "@ash/shared/discussion";
import type { DockChoice } from "./ReplyDock.tsx";
import type { MentionTarget } from "./mentionPicker.ts";
import { sourceWorktreeBranch } from "./taskDerivation.ts";

/**
 * 回复框里 `@` 了一个人：叫谁、来做什么、（派出去时）从哪开工。纯逻辑，组件与回归都从这里取。
 *
 * - 问一句：现在就有的一次性召唤——这一条消息由它在这条任务里答，下一条回到原来的执行器；
 * - 讨论：它（可以再叫一个，三方）和这条任务的执行器各写一段、再来回几轮，最后这条任务的执行器在主会话里
 *   回一段合稿（server/src/discussion.ts）。各方都只说话不改文件；这条任务原来什么状态，说完还是什么状态；
 * - 派出去：开一条新任务交给它，带着这场对话到此为止的背景，挂在这条任务名下（dispatchedBy）。
 *   这条任务的智能体不被叫醒、不占回合，所以它在跑时也能派。
 *
 * 做法排成框顶一行（ReplyCallDock.tsx），选完人默认停在「问一句」。
 */
export type CallVerb = "ask" | "discuss" | "dispatch";
export const CALL_VERBS: readonly CallVerb[] = ["ask", "discuss", "dispatch"];

/** 派出去的新任务从哪开工：接着这条任务的代码 / 从主分支开工。 */
export type DispatchBase = "here" | "trunk";

/**
 * `target` 是胶囊上那个人；讨论时可以再叫一个（`others`，三方），问一句和派出去只认 `target`，离开讨论就清掉。
 * `rounds` 是讨论来回几轮（记着上次的选择）。`review` 是派出去的新任务谁来审，缺省 = 默认审查者
 * （shared/src/review-on-create.ts）；新建框里叫人不派出去，用不到它。
 */
export type ReplyCall = {
  target: MentionTarget; verb: CallVerb; base: DispatchBase; others: MentionTarget[]; rounds: DiscussionRounds;
  review?: CreateReviewChoice;
};

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
  discuss: {
    label: "讨论",
    tip: "它和这里的执行器各说各的、再来回几段，最后这里的执行器给你一份合稿。两边都只说话，不改文件。",
    send: () => "开始讨论",
    placeholder: () => "要讨论什么…",
  },
  dispatch: {
    label: "派出去",
    tip: "开一条新任务交给它，带着这场对话到此为止的背景。这条任务照常跑；新任务自己审查、自己验收，在「子任务」里看。",
    send: () => "派出去",
    placeholder: () => "交代清楚要做成什么样…",
  },
};

/** `@` 的是这条任务自己的执行器（同一种执行器在这条任务里续同一条会话，问它就是直接写）。 */
export const SELF_ASK_HELD = "它就是这条任务自己的执行器：直接写就是问它。叫它来只能派一条新任务";

/** 讨论 `@` 了这条任务自己的执行器：它本来就是讨论的一方。 */
export const SELF_DISCUSS_HELD = "它就是这条任务自己的执行器，本来就在讨论里：讨论要叫另一个执行器来";

export function isSelfCall(agent: AgentType, ownAgent: AgentType): boolean {
  return agent === ownAgent;
}

/** 这个框里能做哪几种（问一句总能）：派得出去、开得了讨论。 */
export type CallAbility = { dispatchable: boolean; discussable: boolean };

/**
 * 叫上一个人时停在哪一种：自己只有「派出去」；明说了要派 / 要讨论（`/派`、`/讨论`）就停在那儿；其余默认
 * 「问一句」。这里做不了的那一种不会被选上。
 */
export function initialVerb(self: boolean, prefer: CallVerb | null, ability: CallAbility): CallVerb {
  if (self) return ability.dispatchable ? "dispatch" : "ask";
  if (prefer === "dispatch" && ability.dispatchable) return "dispatch";
  if (prefer === "discuss" && ability.discussable) return "discuss";
  return "ask";
}

/** 框顶那一行的几颗。只有「问一句」的地方（团队执行者、审查任务）这一行不出：只有一种做法就不必摆。 */
export function callChoices(self: boolean, ability: CallAbility): DockChoice<CallVerb>[] {
  const verbs = CALL_VERBS.filter((verb) => verb === "ask"
    || (verb === "dispatch" && ability.dispatchable) || (verb === "discuss" && ability.discussable));
  if (verbs.length < 2) return [];
  return verbs.map((verb) => ({
    id: verb,
    label: CALL_COPY[verb].label,
    tip: CALL_COPY[verb].tip,
    held: !self ? null : verb === "ask" ? SELF_ASK_HELD : verb === "discuss" ? SELF_DISCUSS_HELD : null,
  }));
}

// —— 讨论：和谁（胶囊第一段，多选）、几轮（最后一段，点一下换一档） ——

/** 讨论里叫了的全部的人（不含这条任务自己的执行器），按叫的先后。 */
export function discussPeople(call: Pick<ReplyCall, "target" | "others">): MentionTarget[] {
  return [call.target, ...call.others];
}

/**
 * 在「和谁」那一段里点一个人：叫着就放掉（最后一个放不掉，要不叫了点胶囊旁的小叉），没叫就加上（最多再叫
 * `MAX_DISCUSSION_GUESTS` 个；加满了再点别人，换掉后加的那一个）。放掉的是胶囊上那个人时，下一个顶上来。
 */
export function toggleDiscussPerson(
  call: Pick<ReplyCall, "target" | "others">,
  agent: AgentType,
  add: (agent: AgentType) => MentionTarget,
): Pick<ReplyCall, "target" | "others"> {
  const people = discussPeople(call);
  if (people.some((item) => item.agent === agent)) {
    const rest = people.filter((item) => item.agent !== agent);
    return rest.length ? { target: rest[0]!, others: rest.slice(1) } : call;
  }
  const next = [...(people.length >= MAX_DISCUSSION_GUESTS ? people.slice(0, MAX_DISCUSSION_GUESTS - 1) : people), add(agent)];
  return { target: next[0]!, others: next.slice(1) };
}

export function nextRounds(rounds: DiscussionRounds): DiscussionRounds {
  const index = DISCUSSION_ROUND_CHOICES.indexOf(rounds);
  return DISCUSSION_ROUND_CHOICES[(index + 1) % DISCUSSION_ROUND_CHOICES.length]!;
}

const ROUNDS_KEY = "navi:reply-discuss-rounds";
const DEFAULT_ROUNDS: DiscussionRounds = 2;

/** 上次选的几轮（整个浏览器共享，不进库）；没选过是 2 轮。 */
export function readDiscussRounds(): DiscussionRounds {
  try {
    return discussionRoundsOf(JSON.parse(globalThis.localStorage?.getItem(ROUNDS_KEY) ?? "null")) ?? DEFAULT_ROUNDS;
  } catch {
    return DEFAULT_ROUNDS;
  }
}

export function rememberDiscussRounds(rounds: DiscussionRounds): void {
  try { globalThis.localStorage?.setItem(ROUNDS_KEY, JSON.stringify(rounds)); } catch { /* 隐私模式：记不住就算了 */ }
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
 * 这条任务的分支已经没了，「接着这里」无从说起，同样不出，按默认从 HEAD 开。只剩一种时返回那一种，
 * 照它开工、那一段也不出。
 */
export function dispatchBaseOptions(
  task: Pick<Task, "id" | "useWorktree" | "mergeTargetBranch">,
  context: BaseContext | null,
): BaseOption[] {
  if (!context?.isRepo || !context.worktreeDefault) return [];
  const source = sourceWorktreeBranch(task, context.branches);
  if (source && !context.branches.includes(source)) return [];
  const here: BaseOption = { id: "here", label: "接着这里的代码", worktreeBase: source };
  const trunk = task.mergeTargetBranch?.trim() || context.current;
  // 主分支那一头落不了地（合并目标不在本地了）：只剩「接着这里」，别连它一起丢掉。
  if (!trunk || !context.branches.includes(trunk)) return source ? [here] : [];
  if (!source && context.current === trunk) return [];
  return [here, { id: "trunk", label: `从 ${trunk} 开工`, worktreeBase: trunk }];
}

// —— `/派`、`/讨论`：叫上次那个人，停在「派出去」/「讨论」 ——
export const DISPATCH_COMMAND = "/派";
export const DISCUSS_COMMAND = "/讨论";
export const DISPATCH_SLASH_ITEM = { command: DISPATCH_COMMAND, label: "派出去", hint: "开一条新任务交给上次叫的人" };
export const DISCUSS_SLASH_ITEM = { command: DISCUSS_COMMAND, label: "讨论", hint: "找另一个执行器来回几段" };
const CALL_COMMANDS: readonly { command: string; verb: CallVerb; text: RegExp }[] = [
  { command: DISPATCH_COMMAND, verb: "dispatch", text: /^\/派(?:\s+|$)/u },
  { command: DISCUSS_COMMAND, verb: "discuss", text: /^\/讨论(?:\s+|$)/u },
];

/** 正文以 `/派` / `/讨论` 开头：返回停在哪一种和它后面那段（要交代 / 要讨论的话），否则 null。 */
export function parseCallCommand(text: string): { verb: CallVerb; rest: string } | null {
  const trimmed = text.trimStart();
  for (const item of CALL_COMMANDS) {
    const match = item.text.exec(trimmed);
    if (match) return { verb: item.verb, rest: trimmed.slice(match[0].length) };
  }
  return null;
}

/** 斜杠菜单里这一项是不是叫人的命令（是就给出停在哪一种）。 */
export function callCommandVerb(command: string | undefined): CallVerb | null {
  return CALL_COMMANDS.find((item) => item.command === command)?.verb ?? null;
}

/** 正文以 `/派` 开头：返回它后面那段（要交代的话），否则 null。 */
export function parseDispatchCommand(text: string): string | null {
  const parsed = parseCallCommand(text);
  return parsed?.verb === "dispatch" ? parsed.rest : null;
}

// —— 记住上次叫的是谁、对每个人用的模型和智能水平（整个浏览器共享，不进库）——
type Remembered = Pick<MentionTarget, "executorId" | "model" | "reasoningEffort">;
export type CallMemory = { last: AgentType | null; byAgent: Partial<Record<AgentType, Remembered>> };

const MEMORY_KEY = "navi:reply-call";
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
