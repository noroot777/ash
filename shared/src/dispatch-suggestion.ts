// 挂在回复框顶上、等用户派出去的活。智能体列出一批（MCP `suggest_dispatch`），说明写好挂在框顶；
// 用户可以换人、改标题和说明、补一句、选从哪开工、点叉丢掉，按「派出去」由 navi 照那一行此刻的样子
// 建任务、挂在这条任务名下、交给调度（server/src/dispatch-suggestion*.ts）——智能体不必、也不该再建一遍。
//
// 智能体摆这一批时只说清一件事：**要不要等用户**（`DispatchWait`）。
//   · none：不等。它照常收尾、可以确认完成，用户什么时候派都行。挂着的一直留到有人明着处理它，只有三种
//     去处——用户派出去、用户点叉、挂它的智能体收回（`withdraw`，要写一句为什么）。没有按回合、按时间收掉的：
//     用户还没处理的东西不在他不知情时消失。同一个标题不挂第二件。
//   · done：等，派完就是这条任务的最后一步。这一批借提问那一格停住任务（写下 `task.question`，一句看得懂的
//     清单），结算落暂停、队列不自动续跑、刷新还在；手机、飞书不认识这一批也看得出在等什么、能回一句。用户把
//     这一批处理完（全派出、或派一部分其余点叉、或全点叉）那一下由 navi 把任务结成完成、不叫醒它，建好的
//     清单记在问答记录上（`QuestionRecord.undelivered`），下一回合开头补交。
//   · continue：等，且要结果。处理完时把建好的清单作为答复续上它的会话。
// 对等着的那一问回一句话 = 「发回去改」：一条不建、那一批从框顶撤下，答复里说清没派出。同一时刻只等用户
// 一样东西：有提问在等时摆不出要等的一批，摆了之后也问不出来。
//
// 等着的那一批只在「那一问还是它」时算数（每一件记着它绑的那一问 `question`）：那一问被答掉、被新消息撤下、
// 被新的提问换掉，这一批跟着作废（服务端读这一列时就不认它），不必在每一处清提问的地方另清一遍。这一批里
// 已经派出或点叉的那几件留一个了结记录（`settled`），处理完时清单据它写，之后整批拿掉；了结记录不下发。
//
// 收回的那一件和它的原因是**同一笔**落库的（`WithdrawnSuggestion`）：那一行从框顶不见了，原因就一定读得到。
// 页面按时刻把它写在会话里收回的那一处（web/src/task-detail/suggestions/withdrawalNotes.ts）。这份记录只增不减。
//
// 上线前的两种老数据照旧能看、能派、能发回去改：老建议没有 batch/order/wait（读成各自一批、同时、不等）；
// 老派活单（tasks.dispatch_plan，仍与 question 对得上时）由服务端读这一列时并进来，按它当时说定的
// afterLaunch 读成 wait（没说的按 continue），任何一次写回都把它落成这一列、清掉旧列。
//
// ── HTTP 接口（页面照这一份做）──────────────────────────────────────────────────────────────
//   GET  /tasks/:id、/tasks 的每一条 Task 带：
//          dispatchSuggestions: DispatchSuggestion[]  框顶此刻挂着的全部（不含了结记录），按挂上的先后；
//                                                     wait !== "none" 的那几件是在等的那一批（同一个 batch），
//                                                     任务此时 status=paused、question 是那句清单
//          dispatchWithdrawals: WithdrawnSuggestion[]  收回过的每一件和原因
//          dispatchTarget: DispatchRunTarget | null    「派出去的活交给谁」，没指明交给谁的那几件取它
//   POST /tasks/:id/dispatch-suggestions/launch       用户按「派出去」
//          请求 DispatchSuggestionLaunchInput：{ order, items: [{ id, title, body, extra?, target, review?, worktreeBase? }], attachments? }
//          · 一次可以跨批选；同一批里有前置（key）的，被等的那一件还挂着就得一起派（否则 409）；
//          · 选到等着的那一批时任务不能还在跑（409，等那一回合停下）；
//          响应 200 { launched: true, groupId: string | null, tasks: [{ id, title }], closed: boolean }
//               closed = 等着的那一批这一下处理完了（问答记录随 task.question 事件下发）
//          409 { error, missing?: string[] }  那几件已经派出去、叉掉或被收回了；或卡上一个接一个会互相等住
//   DELETE /tasks/:id/dispatch-suggestions/:sid        用户点叉
//          响应 200 { dropped: boolean, closed: boolean, suggestions: DispatchSuggestion[] }（已经不在了 = dropped:false）
//   PUT  /tasks/:id/dispatch-target                   改「派出去的活交给谁」{ target: DispatchRunTarget | null } → Task
//   「发回去改」就是对那一问的普通答复：POST /tasks/:id/answer { answer }。
//   SSE：框顶有变化（挂、收回、派、叉）发 task.updated（整条 Task）；等着的那一批摆出来 / 处理完 / 发回去，另发
//   task.question（question 置上或清空，处理完与发回去时带 answeredQuestion）。
import type { DispatchRunTarget } from "./dispatch-target.ts";
import { targetOf } from "./dispatch-target.ts";
import { parseCreateReviewChoice, type CreateReviewChoice } from "./review-on-create.ts";

export type DispatchOrder = "serial" | "parallel";
/** 要不要等用户（见文件头）。 */
export type DispatchWait = "none" | "done" | "continue";
/** 新任务从哪开工：从主分支开工 / 接着这条任务的代码。 */
export type DispatchSuggestionBase = "trunk" | "here";

export type DispatchSuggestion = {
  id: string;
  title: string;
  /** 完整说明：建出来的任务正文就是它（用户改过就是改过的）。 */
  body: string;
  /** 那一行「为什么」。 */
  note: string;
  /** 智能体指明了交给谁；null = 这条任务「派出去的活交给谁」的默认值。 */
  target: DispatchRunTarget | null;
  base: DispatchSuggestionBase;
  proposedAt: string;
  /** 同一次调用挂上的是一批：key / 前置只在同一批里认，order 是这一批卡上默认的排法。 */
  batch: string;
  order: DispatchOrder;
  wait: DispatchWait;
  /** 同一批里的本地标识，`prerequisites` 用它指这一件。 */
  key?: string;
  /** 建在哪几条上面：同一批写 key，已有的任务写 id。同批被等的那一件派出去之后，这里换成它建出来的任务 id。 */
  prerequisites?: string[];
  labels?: string[];
  /** 谁来审（review-on-create.ts）；缺省 = 默认审查者。 */
  review?: CreateReviewChoice;
  // 下面三样只有老派活单上才有（智能体当时能指定）；新挂的从哪开工只看 base。
  useWorktree?: boolean;
  worktreeBase?: string | null;
  mergeTargetBranch?: string | null;
};

/** 等着的那一批里已经派出（task）或点叉（null）的一件：处理完时据它写清单。 */
export type SettledSuggestion = { at: string; task: { id: string; title: string; target: DispatchRunTarget } | null };

/** 库里那一份：比页面多绑的那一问和了结记录。 */
export type StoredSuggestion = DispatchSuggestion & { question?: string; settled?: SettledSuggestion };

/** 智能体收回一件：哪一件、为什么（这句话原样给用户看）。 */
export type DispatchSuggestionWithdrawal = { id: string; reason: string };

/**
 * 收回过的一件留下的记录：是哪一件、叫什么、为什么、什么时候。跟拿掉那一件同一笔落库，随任务下发。
 * 每一件都留着、跟任务同寿：没有条数上限、没有过期——这里没有任何东西知道用户看没看过。
 */
export type WithdrawnSuggestion = { id: string; title: string; reason: string; at: string };

/** 用户按「派出去」时交给 navi 的那一件：此刻那一行上的样子。 */
export type DispatchSuggestionLaunchItem = {
  id: string;
  title: string;
  body: string;
  /** 用户补的那句话（只有选中着派时才有）。 */
  extra?: string;
  target: DispatchRunTarget;
  /** 谁来审；缺省 = 那一件上记的（再缺省是默认审查者）。 */
  review?: CreateReviewChoice;
  /** 开工起点；null = 项目目录此刻的 HEAD；不给 = 那一件上记的。 */
  worktreeBase?: string | null;
};

export type DispatchSuggestionLaunchInput = {
  order: DispatchOrder;
  items: DispatchSuggestionLaunchItem[];
  /** 选中着派时框里贴的图：随新任务走。 */
  attachments?: string[];
};

/** 一次至多挂几件、一条任务上至多挂着几件。 */
export const MAX_SUGGESTIONS_PER_CALL = 12;
export const MAX_SUGGESTIONS_PER_TASK = 24;
export const MAX_SUGGESTION_NOTE_LEN = 120;
export const MAX_WITHDRAW_REASON_LEN = 120;

export const DISPATCH_ORDER_LABEL: Record<DispatchOrder, string> = { serial: "一个接一个", parallel: "同时" };

/** 补的话接在说明后面，标明是用户说的，跟智能体写的说明分得开。 */
export const SUGGESTION_EXTRA_HEADING = "## 用户补充";

export function suggestionTaskBody(body: string, extra?: string | null): string {
  const said = extra?.trim();
  return said ? `${body.trimEnd()}\n\n${SUGGESTION_EXTRA_HEADING}\n\n${said}` : body;
}

/**
 * 等着的那一批处理完、建了任务时交给智能体的那段话（server dispatch-suggestion-wait.ts `launchReply`）以它开头。
 * 那段话只是回执：用户在会话里看到的是每条新任务各一句「开了新任务」（web dispatchNotes.ts），所以会话里认出
 * 这一问就不再画成一颗「你」的气泡。
 */
export const DISPATCH_LAUNCH_REPLY_LEAD = "用户按了「派出去」：";

/**
 * 这条问答记录是不是派出去那一下留下的。认结构化标记（`dispatchLaunch`）；没有标记的老记录只认派出那一下的
 * 完整形状——用户答的那一句是「派出这 N 个任务」开头、交给智能体的那段是派出回执开头——用户自己在普通问答
 * 里贴一段回执，`answer` 是他贴的原文，对不上。
 */
export function isDispatchLaunchRecord(record: { answer?: string; reply?: string; dispatchLaunch?: true }): boolean {
  if (record.dispatchLaunch) return true;
  return /^派出这 \d+ 个任务\n/.test(record.answer ?? "")
    && (record.reply ?? "").replace(/^【答复】\s*/, "").startsWith(DISPATCH_LAUNCH_REPLY_LEAD);
}

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.length && value.every((entry) => typeof entry === "string") ? value : undefined;
const optionalRef = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === "string" ? value : undefined;

function settledOf(value: unknown): SettledSuggestion | undefined {
  const raw = value as { at?: unknown; task?: { id?: unknown; title?: unknown; target?: unknown } | null } | null;
  if (!raw || typeof raw !== "object" || typeof raw.at !== "string") return undefined;
  if (raw.task === null) return { at: raw.at, task: null };
  const target = targetOf(raw.task?.target);
  if (!raw.task || typeof raw.task.id !== "string" || typeof raw.task.title !== "string" || !target) return undefined;
  return { at: raw.at, task: { id: raw.task.id, title: raw.task.title, target } };
}

/**
 * 一件按已知的几样重建：多出来的键（更早的版本记过回合令牌）不要，缺的按老数据的意思补——没有 batch 的
 * 自成一批、同时、不等。认不出（缺 id / 标题 / 说明）给 null。
 */
export function storedSuggestionOf(value: unknown): StoredSuggestion | null {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.title !== "string" || typeof raw.body !== "string") return null;
  const wait: DispatchWait = raw.wait === "done" || raw.wait === "continue" ? raw.wait : "none";
  const review = parseCreateReviewChoice(raw.review);
  const settled = settledOf(raw.settled);
  const worktreeBase = optionalRef(raw.worktreeBase);
  const mergeTargetBranch = optionalRef(raw.mergeTargetBranch);
  return {
    id: raw.id, title: raw.title, body: raw.body, note: typeof raw.note === "string" ? raw.note : "",
    target: targetOf(raw.target), base: raw.base === "here" ? "here" : "trunk",
    proposedAt: typeof raw.proposedAt === "string" ? raw.proposedAt : "",
    batch: typeof raw.batch === "string" && raw.batch ? raw.batch : raw.id,
    order: raw.order === "serial" ? "serial" : "parallel",
    wait,
    ...(wait !== "none" && typeof raw.question === "string" ? { question: raw.question } : {}),
    ...(typeof raw.key === "string" && raw.key ? { key: raw.key } : {}),
    ...(stringList(raw.prerequisites) ? { prerequisites: stringList(raw.prerequisites) } : {}),
    ...(stringList(raw.labels) ? { labels: stringList(raw.labels) } : {}),
    ...(review && !(typeof review === "object" && "error" in review) ? { review } : {}),
    ...(typeof raw.useWorktree === "boolean" ? { useWorktree: raw.useWorktree } : {}),
    ...(worktreeBase !== undefined ? { worktreeBase } : {}),
    ...(mergeTargetBranch !== undefined ? { mergeTargetBranch } : {}),
    ...(settled ? { settled } : {}),
  };
}

/** 那一列原样读回来（认不出的那几件不要）。归一（老派活单、作废的那一批）在服务端读的那一处。 */
export function parseDispatchSuggestions(raw: string | null | undefined): StoredSuggestion[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => storedSuggestionOf(item) ?? []);
  } catch {
    return [];
  }
}

/** 还挂着的（了结记录不算）。 */
export const hangingSuggestions = <T extends StoredSuggestion>(items: readonly T[]): T[] => items.filter((item) => !item.settled);

/** 下发给页面的那一份：还挂着的那几件，不带绑的那一问和了结记录。 */
export function publicSuggestions(items: readonly StoredSuggestion[]): DispatchSuggestion[] {
  return hangingSuggestions(items).map(({ question: _question, settled: _settled, ...item }) => item);
}

export function parseWithdrawnSuggestions(raw: string | null | undefined): WithdrawnSuggestion[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is WithdrawnSuggestion =>
      !!item && typeof item.id === "string" && typeof item.title === "string" && typeof item.reason === "string" && typeof item.at === "string");
  } catch {
    return [];
  }
}
