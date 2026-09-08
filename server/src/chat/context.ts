import { eq } from "drizzle-orm";
import type { ChatMember } from "@ash/shared/chat";
import { db } from "../db/index.js";
import { chatRooms, chatSummaries } from "../db/schema.js";
import { now } from "../util.js";
import { withGlobalBrowserPolicy } from "../browser-verification-policy.js";
import type { invokeChat } from "./execution.js";
import { chatPrompt } from "./prompt.js";
import { CHAT_CONTEXT_POLICY, estimateChatTokens, parseChatSummary, summaryPrompt, type ChatContextPolicy } from "./context-format.js";
import { captureChatHistory, chatHasPending, contextState, readChatHistory, recoverChatContext, resetChatContext, setContextState } from "./context-store.js";
import { abortable } from "./invocation-queue.js";

type Room = typeof chatRooms.$inferSelect;
type Job = { abort: AbortController; promise: Promise<unknown> };

export class ChatContextManager {
  private jobs = new Map<string, Job>();
  private generations = new Map<string, number>();
  constructor(private invoke: typeof invokeChat, private policy: ChatContextPolicy = CHAT_CONTEXT_POLICY) {}

  capture = captureChatHistory;
  recover = recoverChatContext;

  async stop(roomId: string) {
    this.generations.set(roomId, (this.generations.get(roomId) ?? 0) + 1);
    const job = this.jobs.get(roomId);
    job?.abort.abort(new Error("你已停止历史整理；摘要和原文已保留，下次点名时按需继续。"));
    await setContextState(roomId, "stopped", "你已停止历史整理；摘要和原文已保留，下次点名时按需继续。");
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
    const combined = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(300000)]);
    const job: Job = { abort, promise: Promise.resolve() };
    job.promise = Promise.resolve().then(() => operation(combined)).finally(() => {
      if (this.jobs.get(roomId) === job) this.jobs.delete(roomId);
    });
    this.jobs.set(roomId, job);
    return await job.promise as T;
  }

  async prepare(room: Room, member: ChatMember, cutoff: number, request: string, signal: AbortSignal): Promise<string> {
    return this.locked(room.id, signal, async (sharedSignal) => {
      if ((await contextState(room.id))?.status === "stopped") await setContextState(room.id, "idle");
      const overhead = estimateChatTokens(withGlobalBrowserPolicy(chatPrompt(member, [], request), "full"));
      const budget = this.policy.inputTokens - overhead;
      if (budget <= this.policy.summaryTokens) throw new Error("本次消息过长，无法为群聊历史保留空间，请缩短消息后重新 @。");
      const history = await this.compact(room, member, cutoff, budget, sharedSignal);
      return chatPrompt(member, history.messages.map((message) => message.content), request, history.summary?.body);
    });
  }

  async prewarm(roomId: string, member: ChatMember): Promise<void> {
    const generation = this.generations.get(roomId) ?? 0;
    if (this.jobs.has(roomId) || await chatHasPending(roomId)) return;
    const room = (await db.select().from(chatRooms).where(eq(chatRooms.id, roomId))).at(0);
    if (!room) return;
    const members = JSON.parse(room.members) as ChatMember[];
    const currentMember = members.find((entry) => entry.id === member.id);
    if (!currentMember) return;
    const state = await contextState(roomId);
    if (state?.status === "stopped" || (state?.status === "failed" && Date.now() - Date.parse(state.updatedAt) < 300000)) return;
    await this.locked(roomId, new AbortController().signal, async (signal) => {
      if ((this.generations.get(roomId) ?? 0) !== generation) return;
      if (await chatHasPending(roomId)) return;
      const cutoff = await this.capture(roomId);
      await this.compact(room, currentMember, cutoff, this.policy.backgroundTokens, signal);
    }).catch(() => { /* compact 已持久化失败；聊天回复本身不受后台结果影响。 */ });
  }

  private async compact(room: Room, member: ChatMember, cutoff: number, trigger: number, signal: AbortSignal) {
    let history = await readChatHistory(room.id, cutoff);
    if (history.tokens <= trigger) return history;
    const state = await contextState(room.id);
    if (state?.status === "failed" && Date.now() - Date.parse(state.updatedAt) < 60000) {
      throw new Error(`历史整理刚刚失败，原始消息已保留；请稍后重新 @。${state.error ?? ""}`);
    }
    const target = Math.min(trigger, this.policy.recentTokens + this.policy.summaryTokens);
    signal.throwIfAborted();
    await setContextState(room.id, "compacting");
    try {
      while (history.tokens > target) {
        signal.throwIfAborted();
        let keep = history.messages.length;
        let recent = 0;
        const recentBudget = Math.max(0, Math.min(this.policy.recentTokens, target - this.policy.summaryTokens));
        while (keep > 0 && recent + history.messages[keep - 1]!.tokens <= recentBudget) {
          recent += history.messages[--keep]!.tokens;
        }
        const previous = history.summary?.body ?? "";
        const batchBudget = Math.min(this.policy.batchTokens, this.policy.inputTokens - estimateChatTokens(withGlobalBrowserPolicy(summaryPrompt(previous, [], this.policy.summaryTokens), "full")));
        const batch = [] as typeof history.messages;
        let batchTokens = 0;
        for (const message of history.messages.slice(0, keep)) {
          if (batchTokens + message.tokens > batchBudget) break;
          batch.push(message);
          batchTokens += message.tokens;
        }
        if (!batch.length) throw new Error("单条历史消息超出整理预算，原文已保留，未截断消息。");
        const prompt = summaryPrompt(previous, batch.map((entry) => entry.content), this.policy.summaryTokens);
        const summary = parseChatSummary(await this.invoke(member, room.ownerUserId, prompt, signal, room.projectId, { purpose: "summary" }), this.policy.summaryTokens);
        signal.throwIfAborted();
        const tokens = estimateChatTokens(JSON.stringify(summary));
        if (tokens >= (history.summary?.tokens ?? 0) + batchTokens) throw new Error("摘要未缩短历史，原始消息已保留。");
        await db.transaction(async (tx) => {
          signal.throwIfAborted();
          await tx.insert(chatSummaries).values({ roomId: room.id, throughSequence: batch.at(-1)!.sequence, body: summary, tokens, createdAt: now() });
        });
        history = await readChatHistory(room.id, cutoff);
      }
      signal.throwIfAborted();
      await setContextState(room.id, "idle");
      return history;
    } catch (error) {
      const reason = signal.aborted ? String(signal.reason instanceof Error ? signal.reason.message : "历史整理已停止，原文已保留。")
        : error instanceof Error ? error.message : String(error);
      await setContextState(room.id, signal.aborted ? "stopped" : "failed", reason.slice(0, 500));
      throw error;
    }
  }
}
