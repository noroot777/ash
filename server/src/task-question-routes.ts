// 提问 / 答复两个端点(从 task-run-routes.ts 按职责拆出,那边顶到 700 行上限)。
// 语义与归属:提问状态写在 task.question(task-question.ts),答复的投递在 task-answer.ts;
// 这里只做 HTTP 形状校验与回合/方向身份核对。
import type { QuestionItem } from "@ash/shared";
import {
  MAX_QUESTION_ITEMS,
  MAX_QUESTION_OPTION_LEN,
  MAX_QUESTION_OPTIONS,
} from "@ash/shared";
import { eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { checkChoiceQuestion, choiceQuestionRejection } from "./choice-question-check.js";
import { recurrenceBreakerArmed } from "./review-recurrence-gate.js";
import { turnRole } from "./runs.js";
import { answerTask } from "./task-answer.js";
import { setTaskQuestion, waitSlotTaken } from "./task-question.js";
import { listDispatchSignals } from "./dispatch-signals.js";
import { activeDispatchPlan, parseDispatchPlan } from "@ash/shared/dispatch-plan";
import { DISPATCH_PLAN_BLOCKS_ASK } from "./dispatch-plan.js";
import { actorOf } from "./auth/context.js";
import { canSeeProject, visibleProjectIds } from "./auth/visibility.js";

export function mountTaskQuestionRoutes(api: Hono): void {
// 提问(对称 /pause,§Team):agent 在执行中调用,写下「我被这个问题卡住了」。
// 执行者:本回合自然退出后,settleTaskStatus 因 question 非空落 paused,且队列**不**
// 自动续跑(pickNextLaunchable 挡住);问题即时投递给团队调度者,answer_question
// 的答复会清空 question 并带着答复 resume 同一 CLI 会话。
// 团队调度者自己也能调 → 界面上就是「调度者在等你答复」,答复喂回它的常驻会话。
// 没人管也能用:任务停在 paused,问题留在 task.question 等用户答复。
// 可选的 options = 单问题候选答案；questionItems = 一次并列问几个相关决策，每个
// 问题有自己的 options。候选按钮只填入对应输入框，最终仍合成一段文本走 /answer。
// 一次性任务只接受 running;常驻调度台例外(§Team):它的 status 会在 running/idle
// 间切换,但能发出 ask_question 就说明这一轮活着,不能被 idle 挡掉。
function normalizeQuestionOptions(raw: unknown, field: string): { options: string[] } | { error: string } {
  if (raw === undefined) return { options: [] };
  if (!Array.isArray(raw) || raw.some((o) => typeof o !== "string")) {
    return { error: `${field} 必须是字符串数组` };
  }
  // trim + 去空 + 去重后落库；超限明确报错，不静默截断。
  const options = [...new Set(raw.map((o) => o.trim()).filter(Boolean))];
  if (options.length > MAX_QUESTION_OPTIONS) {
    return { error: `${field} 最多 ${MAX_QUESTION_OPTIONS} 个候选答案，收到 ${options.length} 个` };
  }
  const tooLong = options.find((o) => o.length > MAX_QUESTION_OPTION_LEN);
  if (tooLong) {
    return {
      error: `${field} 的单个候选答案不超过 ${MAX_QUESTION_OPTION_LEN} 字，展开说明请写进 question：「${tooLong.slice(0, 30)}…」`,
    };
  }
  return { options };
}

function normalizeQuestionItems(raw: unknown): { items: QuestionItem[] | null } | { error: string } {
  if (raw === undefined) return { items: null };
  if (!Array.isArray(raw)) return { error: "questionItems 必须是问题数组" };
  if (raw.length > MAX_QUESTION_ITEMS) {
    return { error: `一次最多 ${MAX_QUESTION_ITEMS} 个问题，收到 ${raw.length} 个` };
  }
  const items: QuestionItem[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: `questionItems[${i}] 必须是 { question, options? }` };
    }
    const record = item as Record<string, unknown>;
    if (typeof record.question !== "string" || !record.question.trim()) {
      return { error: `questionItems[${i}].question 不能为空` };
    }
    const normalized = normalizeQuestionOptions(record.options, `questionItems[${i}].options`);
    if ("error" in normalized) return normalized;
    items.push({
      question: record.question.trim(),
      ...(normalized.options.length ? { options: normalized.options } : {}),
    });
  }
  return { items: items.length ? items : null };
}

api.post("/tasks/:id/ask", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req
    .json<{ question?: string; options?: unknown; questionItems?: unknown }>()
    .catch(() => ({}) as { question?: string; options?: unknown; questionItems?: unknown });
  const q = (b.question ?? "").trim();
  if (!q) return c.json({ error: "question 不能为空" }, 400);
  const normalizedOptions = normalizeQuestionOptions(b.options, "options");
  if ("error" in normalizedOptions) return c.json({ error: normalizedOptions.error }, 400);
  const normalizedItems = normalizeQuestionItems(b.questionItems);
  if ("error" in normalizedItems) return c.json({ error: normalizedItems.error }, 400);
  const opts = normalizedOptions.options;
  const questionItems = normalizedItems.items;
  if (questionItems && opts.length) {
    return c.json({ error: "多问题请把候选答案放进各 questionItems[i].options，不要同时传顶层 options" }, 400);
  }
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.mode !== "team" && r.status !== "running")
    return c.json({ error: "只能在任务正在运行时提问", status: r.status }, 409);
  // 同一时刻只有一样东西在等用户：这一回合已经摆了派活单，就不能再问（dispatch-plan-routes.ts 反过来也拦）。
  if (activeDispatchPlan({ question: r.question, dispatchPlan: parseDispatchPlan(r.dispatchPlan) })) {
    return c.json({ error: DISPATCH_PLAN_BLOCKS_ASK }, 409);
  }
  const askToken = c.req.header("x-ash-turn-token");
  if (r.mode !== "team" && r.activeTurnToken && askToken !== r.activeTurnToken) {
    return c.json({
      error: askToken
        ? "提问来自已结束的回合，已拒绝写入当前会话"
        : "MCP 未携带当前回合身份（执行器可能过滤了 ASH_TURN_TOKEN），提问已拒绝写入",
    }, 409);
  }
  const askDirection = c.req.header("x-ash-direction-token");
  if (r.mode !== "team" && r.activeDirectionToken && askDirection !== r.activeDirectionToken) {
    return c.json({ error: askDirection
      ? "提问的方向身份已过期；请从最新用户消息的【当前方向身份】复制 directionToken 后重试 ask_question"
      : "MCP 未携带当前方向身份（请传当前消息附带的 directionToken），提问已拒绝写入" }, 409);
  }
  // 熔断修复里的提问是交给用户拍板的选择题：过机械格式校验，不过就退回并逐条说改什么
  //（判据见 choice-question-check.ts；只认熔断修复还在继续的那个方向世代，见 review-recurrence-gate.ts）。
  // 审查回合不在此列 —— 熔断卡的是执行者。
  if (r.mode !== "team" && r.workflowMode === "free" && turnRole(taskId) !== "reviewer"
    && await recurrenceBreakerArmed(taskId, r.directionEpoch)) {
    const problems = checkChoiceQuestion({ question: q, options: opts, items: questionItems });
    if (problems.length) return c.json({ error: choiceQuestionRejection(problems), problems }, 400);
  }
  const asked = await setTaskQuestion({
    taskId,
    question: q,
    options: opts,
    items: questionItems,
    ...(r.mode === "team" ? {} : { currentTurn: {
      token: r.activeTurnToken,
      directionToken: r.activeDirectionToken,
    } }),
  });
  if (!asked) {
    const latest = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (latest && waitSlotTaken(latest, false)) return c.json({ error: DISPATCH_PLAN_BLOCKS_ASK }, 409);
    return c.json({ error: "当前回合已经结束或已被引导，提问未写入" }, 409);
  }
  return c.json({
    asked: true,
    options: opts,
    questionItems,
    willSettleAs: r.mode === "team" ? "idle" : "paused",
  });
});

// 答复一个提问暂停中的任务(调度者或用户都可调):清空 question,把答复作为
// 消息 resume 它的 CLI 会话继续跑。提问回合还没结算完(running/queued)时拒绝
// ——等它落 paused 再答,否则答复会被单飞锁静默丢掉。
// 例外:常驻调度台(§Team)自己调 ask_question 问用户时,这道挡板不适用 —— 它正在
// 说话时也接得住(continueTask → deliverToLead 先 interrupt 再写 stdin),跟
// 「插话」走的是同一条路。挡住反而会让用户对着一个明明在线的调度台干等。
api.post("/tasks/:id/answer", (c) => answerTask(c, c.req.param("id")));

// 这条任务名下派出的任务来问 / 失败的那几刻（dispatch-signals.ts）：派它的那条任务的会话里那几颗气泡。
api.get("/tasks/:id/dispatch-signals", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r || !(await canSeeProject(actorOf(c), r.projectId))) return c.json({ error: "not found" }, 404);
  const signals = await listDispatchSignals(taskId);
  // 派出的任务可以在别的项目里：那一条看不见，它的提问、失败也不给看。
  const visible = await visibleProjectIds(actorOf(c));
  if (visible === null || !signals.length) return c.json(signals);
  const ids = [...new Set(signals.map((signal) => signal.taskId))];
  const seen = new Set((await db.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(inArray(tasks.id, ids)))
    .filter((row) => visible.has(row.projectId)).map((row) => row.id));
  return c.json(signals.filter((signal) => seen.has(signal.taskId)));
});
}
