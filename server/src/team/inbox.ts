// 工人 → 指挥者的入站唤醒。唯一入口:settleTaskStatus 结算完一个工人回合后调它。
//
// 只有三种事值得花一轮模型调用去叫醒指挥者:①工人提问 ②工人失败 ③派活时点名
// 要汇报的工人完成(reportBack)。其余 done 一律静默 —— 界面上工人状态自己就变了,
// 指挥者随时能 list_tasks 查,没必要为「又完成一个」烧一整个回合。
//
// 投递是**即时**的(直接写常驻进程的 stdin),不再经 scheduledMessages 的 30s tick;
// 忙的时候由 session.ts 缓冲、回合结束合并成一条送(N 个工人只花一次调用)。
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
): Promise<void> {
  if (!worker.parentId) return; // 不是谁的工人
  if (kind === "done" && !worker.reportBack) return; // 静默完成
  const lead = (await db.select().from(tasks).where(eq(tasks.id, worker.parentId))).at(0);
  if (!lead || lead.mode !== "team" || lead.archived) return;

  const ref = { id: worker.id, title: worker.title || worker.id };
  const text =
    kind === "question"
      ? INBOUND_QUESTION(ref, withOptions(worker, question))
      : kind === "done"
        ? INBOUND_DONE(ref)
        : INBOUND_FAILED(ref, kind === "failed_unconfirmed");
  await sendInbound(lead.id, text);
}

// 工人提问时给了候选答案(ask_question 的 options)就一并列出来 —— 指挥者照着挑一个
// 答,比自由发挥更贴合工人的处境;它也可以答别的,候选只是建议。脏 JSON 不该拖垮
// 一条通知,解析失败就当没给候选。
function withOptions(worker: typeof tasks.$inferSelect, question?: string | null): string {
  const q = (question ?? worker.question ?? "").trim() || "(工人没写清问题,去它的会话里看)";
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
