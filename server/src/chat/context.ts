import { eq } from "drizzle-orm";
import type { ChatMember } from "@ash/shared/chat";
import { db } from "../db/index.js";
import { chatRooms, chatSummaries } from "../db/schema.js";
import { now } from "../util.js";
import { withGlobalBrowserPolicy } from "../browser-verification-policy.js";
import type { invokeChat } from "./execution.js";
import { chatPrompt } from "./prompt.js";
import { CHAT_CONTEXT_POLICY, SIDE_CHAT_CONTEXT_POLICY, estimateChatTokens, parseChatSummary, summaryPrompt, type ChatContextPolicy } from "./context-format.js";
import { acknowledgeContextFailure, captureChatHistory, captureChatSnapshot, chatHasPending, contextState, readChatHistory, readChatSummary, recoverChatContext, resetChatContext, setContextState, showContextFailure } from "./context-store.js";
import { abortable } from "./invocation-queue.js";

type Room = typeof chatRooms.$inferSelect;
type Job = { abort: AbortController; promise: Promise<unknown>; compacting: boolean };

export class ChatContextManager {
  private jobs = new Map<string, Job>();
  private generations = new Map<string, number>();
  private prewarmStopped = new Set<string>();
  constructor(private invoke: typeof invokeChat, private policy: ChatContextPolicy = CHAT_CONTEXT_POLICY, private sidePolicy: ChatContextPolicy = SIDE_CHAT_CONTEXT_POLICY) {}

  /** 预算按房间类型走：侧聊带的是主会话整份快照，跟群聊不是一个量级（见 context-format.ts）。 */
  private policyOf(room: Pick<Room, "kind">): ChatContextPolicy {
    return room.kind === "side" ? this.sidePolicy : this.policy;
  }

  capture = captureChatHistory;
  captureSnapshot = captureChatSnapshot;
  recover = recoverChatContext;

  async stop(roomId: string) {
    this.generations.set(roomId, (this.generations.get(roomId) ?? 0) + 1);
    this.prewarmStopped.add(roomId);
    const job = this.jobs.get(roomId);
    job?.abort.abort(new Error("你已停止历史整理；摘要和原文已保留，下次点名时按需继续。"));
    if (job?.compacting || (await contextState(roomId))?.status === "compacting") {
      await setContextState(roomId, "stopped", "你已停止历史整理；摘要和原文已保留，下次点名时按需继续。");
    }
  }

  async clear(roomId: string, command: { id: string; body: string; author: string }) {
    await this.jobs.get(roomId)?.promise.catch(() => {});
    await resetChatContext(roomId, command);
  }

  private async locked<T>(roomId: string, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    while (this.jobs.has(roomId)) {
      await abortable(this.jobs.get(roomId)!.promise.catch(() => {}), signal);
    }
    signal.throwIfAborted();
    const abort = new AbortController();
    const combined = AbortSignal.any([signal, abort.signal]);
    const job: Job = { abort, promise: Promise.resolve(), compacting: false };
    job.promise = Promise.resolve().then(() => operation(combined)).finally(() => {
      if (this.jobs.get(roomId) === job) this.jobs.delete(roomId);
    });
    this.jobs.set(roomId, job);
    return await job.promise as T;
  }

  /**
   * 拼出这一轮要发给执行器的提示词。`onDegrade` 在「历史给当前消息让路」时回调一次，调用
   * 方负责把这句话展示给用户——降级是静默不得的，否则用户以为它看过主会话历史。
   */
  async prepare(room: Room, member: ChatMember, cutoff: number, request: string, signal: AbortSignal, tail: string[] = [], format = chatPrompt, reserveTokens = 0, onDegrade?: (notice: string) => void): Promise<string> {
    return this.locked(room.id, signal, async (sharedSignal) => {
      sharedSignal.throwIfAborted();
      this.prewarmStopped.delete(room.id);
      if ((await contextState(room.id))?.status === "stopped") await setContextState(room.id, "idle");
      const overhead = estimateChatTokens(withGlobalBrowserPolicy(format(member, tail, request), "full"));
      const policy = this.policyOf(room);
      const budget = policy.inputTokens - overhead - reserveTokens;
      if (budget <= policy.summaryTokens) {
        // 侧聊不因「你这条消息太长」拒收（用户 2026-09-21 指定：和主会话一样）。主任务的
        // /reply 只看非空，长不长由执行器自己说；在这里抛错的话，HTTP 早就回了 202、前端
        // 也已经按「已发送」清掉草稿，用户只剩一个异步失败回合，材料还得重打一遍。所以让
        // 历史给当前消息让路：带上已有摘要、不带原文，能不能吃下交给执行器自己报。
        if (room.kind === "side") {
          const summary = await readChatSummary(room.id, cutoff);
          onDegrade?.(`⚠️ 本次消息很长，本轮没有带上主会话快照原文${summary ? "（已有摘要仍然带上）" : ""}。能否处理这么长的输入由所选执行器决定；想让它对着主会话历史回答，可以把消息拆短再问一次。`);
          return format(member, tail, request, summary?.body);
        }
        throw new Error(tail.length
          ? "较早的回复尚未完成，后续消息已超出上下文预算。请等待或停止较早回复后重新 @，原文已保留。"
          : "本次消息过长，无法为历史保留空间，请缩短消息后重新 @。");
      }
      const history = await this.compact(room, member, cutoff, budget, sharedSignal);
      return format(member, [...history.messages.map((message) => message.content), ...tail], request, history.summary?.body);
    });
  }

  async prewarm(roomId: string, member: ChatMember): Promise<void> {
    const generation = this.generations.get(roomId) ?? 0;
    if (this.prewarmStopped.has(roomId) || this.jobs.has(roomId) || await chatHasPending(roomId)) return;
    const room = (await db.select().from(chatRooms).where(eq(chatRooms.id, roomId))).at(0);
    if (!room) return;
    const members = JSON.parse(room.members) as ChatMember[];
    const currentMember = members.find((entry) => entry.id === member.id);
    if (!currentMember) return;
    const state = await contextState(roomId);
    if (state?.status === "stopped" || (state?.failedAt && Date.now() - Date.parse(state.failedAt) < 300000)) return;
    // 兜底时钟只留给后台预热：它没有发起人，界面上也没有能点停止的地方，整理挂住就会一直
    // 占着 jobs[roomId]，把这个房间后续所有 prepare 卡在上面的 while 里。前台整理走 prepare
    // 传进来的回复信号，由用户停止，不再另设时限。
    await this.locked(roomId, AbortSignal.timeout(300000), async (signal) => {
      if (this.prewarmStopped.has(roomId) || (this.generations.get(roomId) ?? 0) !== generation) return;
      if (await chatHasPending(roomId)) return;
      const cutoff = await this.capture(roomId);
      await this.compact(room, currentMember, cutoff, this.policyOf(room).backgroundTokens, signal);
    }).catch(() => { /* compact 已持久化失败；聊天回复本身不受后台结果影响。 */ });
  }

  private async compact(room: Room, member: ChatMember, cutoff: number, trigger: number, signal: AbortSignal) {
    const policy = this.policyOf(room);
    let history = await readChatHistory(room.id, cutoff);
    const state = await contextState(room.id);
    signal.throwIfAborted();
    if (history.tokens <= trigger) {
      if (state?.status === "failed") await acknowledgeContextFailure(room.id);
      return history;
    }
    if (state?.failedAt && Date.now() - Date.parse(state.failedAt) < 60000) {
      await showContextFailure(room.id);
      throw new Error(`历史整理刚刚失败，原始消息已保留；请稍后重新 @。${state.error ?? "上次失败原因未记录。"}`);
    }
    const target = Math.min(trigger, policy.recentTokens + policy.summaryTokens);
    signal.throwIfAborted();
    const job = this.jobs.get(room.id);
    if (job) job.compacting = true;
    await setContextState(room.id, "compacting");
    try {
      while (history.tokens > target) {
        signal.throwIfAborted();
        let keep = history.messages.length;
        let recent = 0;
        const recentBudget = Math.max(0, Math.min(policy.recentTokens, target - policy.summaryTokens));
        while (keep > 0 && recent + history.messages[keep - 1]!.tokens <= recentBudget) {
          recent += history.messages[--keep]!.tokens;
        }
        const previous = history.summary?.body ?? "";
        const batchBudget = Math.min(policy.batchTokens, policy.inputTokens - estimateChatTokens(withGlobalBrowserPolicy(summaryPrompt(previous, [], policy.summaryTokens), "full")));
        const batch = [] as typeof history.messages;
        let batchTokens = 0;
        for (const message of history.messages.slice(0, keep)) {
          if (batchTokens + message.tokens > batchBudget) break;
          batch.push(message);
          batchTokens += message.tokens;
        }
        if (!batch.length) throw new Error("单条历史消息超出整理预算，原文已保留，未截断消息。");
        const prompt = summaryPrompt(previous, batch.map((entry) => entry.content), policy.summaryTokens);
        const summary = parseChatSummary((await this.invoke(member, room.ownerUserId, prompt, signal, room.projectId, { purpose: "summary" })).text, policy.summaryTokens);
        signal.throwIfAborted();
        const tokens = estimateChatTokens(JSON.stringify(summary));
        if (tokens >= (history.summary?.tokens ?? 0) + batchTokens) throw new Error("摘要未缩短历史，原始消息已保留。");
        await db.transaction(async (tx) => {
          signal.throwIfAborted();
          if (!(await tx.select({ id: chatRooms.id }).from(chatRooms).where(eq(chatRooms.id, room.id))).length) throw new Error("聊天已删除。");
          await tx.insert(chatSummaries).values({ roomId: room.id, throughSequence: batch.at(-1)!.sequence, body: summary, tokens, createdAt: now() });
        });
        history = await readChatHistory(room.id, cutoff);
      }
      signal.throwIfAborted();
      await setContextState(room.id, "idle");
      return history;
    } catch (error) {
      const abortReason = signal.reason;
      const canceled = abortReason instanceof Error && abortReason.name === "TimeoutError"
        ? "历史整理超时，已停止；摘要和原文已保留，下次点名时按需继续。"
        : abortReason instanceof Error && abortReason.name !== "AbortError"
          ? abortReason.message : "历史整理已停止；摘要和原文已保留，下次点名时按需继续。";
      const reason = signal.aborted ? canceled
        : error instanceof Error ? error.message : String(error);
      await setContextState(room.id, signal.aborted ? "stopped" : "failed", reason.slice(0, 500));
      if (signal.aborted && error === abortReason) throw new Error(reason);
      throw error;
    }
  }
}
