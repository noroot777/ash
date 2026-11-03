// 迟到的协议拒收**只说它自己那一次输入**:同一轮审查里,旧输入的拒收不许终结已经送进去、
// 正在跑的下一次输入。
//
// 为什么要有这一份(自由审查 j-HtG4Nuqjqa 第 1 轮 R1,已实测):回执写库早就按完整输入身份核了
// (review-input-verdict.ts 的 `persist`),可派发层还有第二条带副作用的路 —— 迟到的拒收经
// `onRefused` → `failReviewStart` 把整轮打成 failed/error,而那道闸只核代次。审查者提问、用户
// 答复,同一轮送进了第二次输入(代次不变、输入身份换了);第一次输入的回执这时才落定成拒收,
// 正在跑的答复回合就被误杀,时间线还写着「审查启动失败：一个字都没送进 agent」。
//
//  L1 端到端:派审(回执悬着)→ 审查者提问 → 真实答复处理器送进第二次输入(收下、正在跑)→ 第一次
//     输入迟到拒收:这一轮仍是 reviewing、回执仍是第二次的 accepted、时间线没有「审查启动失败」;
//     答复回合结束后这一轮按它自己的结局收尾(没交卷 → 「未能正常给出结论」),不是拒收;
//  L2 判据 `reviewInputStillCurrent` 的几档:凭据就是这一次且没有下一次在起跑 → 放行;身份三位任
//     一不同、目录/代次不同、下一次输入正在起跑(`start` 是别人)、说不清是哪一次(null)→ 不放行。
//
// 「没有下一次输入时迟到拒收照常落终态」那一档的正向对照在 test-idle-delivery-verdict.ts 的 D5。
//
// 跑:npm -w server run test:late-refusal-identity
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { InputAcceptance, RunHandle } from "../src/executors/types.js";
import { root, startHarness } from "./free-review-dispatch-harness.js";
import { releaseTmpDb } from "./tmp-db.js";

process.env.ASH_TURN_INPUT_ACK_MS = "30";

try {
  const harness = await startHarness();
  const { db, tasks, until, runOf, roundOf, timeline, turnIdentity, reviewDispatchArmed, finish } = harness;
  const { CodexExecutor } = await import("../src/executors/codex.js");
  const { setTaskQuestion } = await import("../src/task-question.js");
  const { answerTask } = await import("../src/task-answer.js");
  const { reviewInputStillCurrent } = await import("../src/review-input-verdict.js");

  // ── L1 端到端 ─────────────────────────────────────────────────────────────────────
  const id = "late-refusal-after-answer";
  let resolveOld!: (value: InputAcceptance) => void;
  const oldReceipt = new Promise<InputAcceptance>((resolve) => { resolveOld = resolve; });
  let finishAnswer!: () => void;
  const answerHold = new Promise<void>((resolve) => { finishAnswer = resolve; });
  let invocation = 0;
  const row = async () => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const run = (): RunHandle => {
    const current = ++invocation;
    return {
      sessionId: "late-refusal-cli", commandLine: "late refusal stub", kill() {},
      // 第一次输入的回执由用例攥着,第二次(答复)当场收下。
      inputAccepted: current === 1 ? oldReceipt : Promise.resolve<InputAcceptance>("accepted"),
      events: (async function* () {
        if (current === 1) {
          const owner = await row();
          await setTaskQuestion({ taskId: id, question: "继续本轮检查吗？", currentTurn: {
            token: owner.activeTurnToken!, directionToken: owner.activeDirectionToken!,
          } });
          yield { kind: "text" as const, text: "已提出问题，等待答复。" };
        } else {
          yield { kind: "text" as const, text: "收到答复，继续这一轮审查。" };
          await answerHold;
        }
        yield { kind: "done" as const, exitStatus: 0 };
      })(),
    };
  };
  CodexExecutor.prototype.run = run;
  CodexExecutor.prototype.runSteerable = run;

  try {
    await harness.armedTask(id);
    await harness.handleFreeWorkflowSettlement(id, "done", true, true, "single");
    harness.releaseTurn(id, undefined);
    await until("审查者提问、第一回合结束", async () => invocation === 1 && !turnIdentity(id) && !!(await row()).question);
    const review = await runOf(id);
    // 派发观察者也收完尾(交付说不清、认领还回来)才答:不是只抢在原回合收尾前的那一小段窗口。
    await until("原派发的观察者收尾", () => !reviewDispatchArmed(review.id, 1));
    assert.equal((await row()).waitOwnership?.deliveredReview?.acceptance, "unknown", "第一次输入的回执还悬着");

    const api = new Hono();
    api.post("/answer", (context) => answerTask(context, id));
    const response = await api.request("/answer", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "继续检查。" }) });
    assert.equal(response.status, 200);
    await until("答复送进去、收下了、正在跑", async () => invocation === 2 && !!turnIdentity(id)
      && (await row()).waitOwnership?.deliveredReview?.acceptance === "accepted");
    const answering = turnIdentity(id)!.token;
    const second = (await row()).waitOwnership!.deliveredReview!.identity;

    resolveOld("refused");
    // 迟到的拒收要走完:有界等待之外的落定 → 记事实 → 派发层 onRefused → failReviewStart。
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual([(await runOf(id)).status, (await roundOf(review.id)).status], ["reviewing", "reviewing"],
      "旧输入迟到的拒收不许终结已经收下答复、正在跑的这一轮");
    assert.equal(turnIdentity(id)?.token, answering, "答复回合原样在跑");
    const delivered = (await row()).waitOwnership!.deliveredReview!;
    assert.deepEqual([delivered.acceptance, delivered.identity], ["accepted", second],
      "凭据仍是第二次输入的收下 —— 旧拒收只记它自己那一次");
    assert.doesNotMatch(timeline(id), /审查启动失败/, "时间线不许出现与正在运行的现任相矛盾的「启动失败」");

    finishAnswer();
    await until("答复回合结束", () => !turnIdentity(id));
    await until("这一轮按自己的结局收尾", async () => (await roundOf(review.id)).status !== "reviewing");
    assert.match(timeline(id), /未能正常给出结论/, "答复回合没交卷,按它自己的结局收尾");
    assert.doesNotMatch(timeline(id), /明确拒收|审查启动失败/, "收尾原因不是那句过期的拒收");
    console.log("✓ L1 答复已收下、正在跑时,第一次输入迟到的拒收不动这一轮;回合结束后按自己的结局收尾");
  } finally {
    finishAnswer();
    resolveOld("unknown");
  }

  // ── L2 判据各档 ──────────────────────────────────────────────────────────────────
  const identity = { turnToken: "t1", directionToken: "d1", directionEpoch: 3 };
  const input = { directory: "dir", generation: "g", identity };
  const delivered = { ...input, confirmedAt: "now" };
  const task = (waitOwnership: object) => ({ waitOwnership }) as Parameters<typeof reviewInputStillCurrent>[0];
  assert.equal(reviewInputStillCurrent(task({ deliveredReview: delivered }), input, "dir", "g"), true,
    "凭据就是这一次、没有下一次在起跑:放行");
  assert.equal(reviewInputStillCurrent(task({ deliveredReview: delivered, start: { ...input, priorStatus: "done" } }),
    input, "dir", "g"), true, "起跑痕迹也是这一次:放行");
  for (const [field, value] of [["turnToken", "t2"], ["directionToken", "d2"], ["directionEpoch", 4]] as const) {
    assert.equal(reviewInputStillCurrent(task({ deliveredReview: { ...delivered, identity: { ...identity, [field]: value } } }),
      input, "dir", "g"), false, `凭据已经换成下一次(${field} 不同):不放行`);
  }
  assert.equal(reviewInputStillCurrent(task({ deliveredReview: delivered, start: {
    ...input, identity: { ...identity, turnToken: "t2", directionEpoch: 4 }, priorStatus: "done",
  } }), input, "dir", "g"), false, "下一次输入正在起跑(凭据还没换过来):不放行");
  assert.equal(reviewInputStillCurrent(task({ deliveredReview: delivered }), input, "other", "g"), false, "别的轮次");
  assert.equal(reviewInputStillCurrent(task({ deliveredReview: delivered }), input, "dir", "g2"), false, "别的代次");
  assert.equal(reviewInputStillCurrent(task({ deliveredReview: delivered }), null, "dir", "g"), false,
    "说不清是哪一次输入:不放行");
  assert.equal(reviewInputStillCurrent(task({}), input, "dir", "g"), false, "没有凭据:不放行");
  console.log("✓ L2 判据:身份三位、目录、代次、起跑窗口、说不清 各档");

  await finish([id]);
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
