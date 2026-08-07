// 执行者 → 调度者的入站唤醒。唯一入口:settleTaskStatus 结算完一个执行者回合后调它。
//
// 只有三种事值得花一轮模型调用去叫醒调度者:①执行者提问 ②执行者失败 ③派活时点名
// 要汇报的执行者完成(reportBack)。其余 done 一律静默 —— 界面上执行者状态自己就变了,
// 调度者随时能 list_tasks 查,没必要为「又完成一个」烧一整个回合。
//
// 投递是**即时**的(直接写常驻进程的 stdin),不再经 scheduledMessages 的 30s tick;
// 忙的时候由 session.ts 缓冲、回合结束合并成一条送(N 个执行者只花一次调用)。
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tasks } from "../db/schema.js";
import { sendInbound } from "./session.js";
import { INBOUND_DONE, INBOUND_FAILED, INBOUND_QUESTION } from "./prompts.js";

export type InboundKind = "question" | "failed" | "failed_unconfirmed" | "done";

export async function notifyTeamLead(
  worker: typeof tasks.$inferSelect,
  kind: InboundKind,
  question?: string | null,
  /** 结算探到的产出线索（`turn-output.ts`）。调度者拿到「它有 3 个新提交」才不会盲目重派。 */
  outputHint?: string,
): Promise<void> {
  if (!worker.parentId) return; // 不是谁的执行者
  if (kind === "done" && !worker.reportBack) return; // 静默完成
  const lead = (await db.select().from(tasks).where(eq(tasks.id, worker.parentId))).at(0);
  if (!lead || lead.mode !== "team" || lead.archived) return;

  const ref = { id: worker.id, title: worker.title || worker.id };
  const text =
    kind === "question"
      ? INBOUND_QUESTION(ref, withOptions(worker, question))
      : kind === "done"
        ? INBOUND_DONE(ref)
        : INBOUND_FAILED(ref, kind === "failed_unconfirmed", outputHint);
  await sendInbound(lead.id, text);
}

// 执行者提问时把多问题和候选答案完整列出来，调度者才能一次把相关决策都答完。
// 候选只是建议，调度者仍可自由组合；脏 JSON 不该拖垮通知，解析失败就退回纯问题。
function withOptions(worker: typeof tasks.$inferSelect, question?: string | null): string {
  const q = (question ?? worker.question ?? "").trim() || "(执行者没写清问题,去它的会话里看)";
  let items: { question: string; options?: string[] }[] = [];
  try {
    items = worker.questionItems ? (JSON.parse(worker.questionItems) as typeof items) : [];
  } catch {
    items = [];
  }
  if (items.length > 0) {
    return `${q}\n\n它一次问了 ${items.length} 个相关问题，请逐题答复（候选只是建议）：\n${items
      .map((item, i) => {
        const options = item.options?.length
          ? `\n候选建议：\n${item.options.map((o, j) => `  ${j + 1}. ${o}`).join("\n")}`
          : "";
        return `【${i + 1}】${item.question}${options}`;
      })
      .join("\n\n")}`;
  }
  let opts: string[] = [];
  try {
    opts = worker.questionOptions ? (JSON.parse(worker.questionOptions) as string[]) : [];
  } catch {
    opts = [];
  }
  if (opts.length === 0) return q;
  return `${q}\n\n它给的候选答案(可以直接选一个当 answer,也可以答别的):\n${opts
    .map((o, i) => `${i + 1}. ${o}`)
    .join("\n")}`;
}
