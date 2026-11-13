// 有审查的任务：审查出结论之前不推「完成了，等你验收」，审查通过时推的那张就说「审查通过」（理由见 shared
// task-attention.ts humanTurnOf、reconcile.ts resolutionLine）。
//
// 钉住的几件事：
// ① 预约着审查（跑着时预约、修完自动复审）的任务停下来 → 不推；
// ② 最近一条审查正在审 → 不推；
// ③ 「完成了」已经推出去才开审（手动派审）→ 撤回那张，不留一张「完成了」等着审查；
// ④ 审查通过 → 推一张，副标题是「审查通过，等你验收」；
// ⑤ 通过之后执行者又跑了一轮 → 那次通过不算这一版的，回到「完成了，等你验收」；
// ⑥ 用完轮数没通过、没有下一轮 → 推，说「审查没通过，等你决定」，按钮要二次确认；
// ⑦ 修完等自动复审（停着的链 + 续轮预约）→ 不推；
// ⑧ 待验收卡已经写着「审查通过」→ 不另发一条通知；
// ⑨ 失败、取消着的任务派审通过（审查不改任务状态，没有待验收卡）→ 单独发一条「审查通过」，重复对账不重发；
//    审查回合还在跑（状态还没落回原样）时不发；
// ⑩ 没通过之后执行者又跑了一轮、没复审 → 不说「审查没通过」，说完成了、注明新改动还没复审，验收照样二次确认；
// ⑪ 通过结论落在「审查通过」这一样启用之前的（水位），不补推；
// ⑫ 升级时正在审、启动后才通过 → 照样推：有旧账、一行账都没有都一样，取消、暂停着都一样；那一下的事件丢了
//    （取消着的任务不在全量对账的常规候选里）由全量对账补上；
// ⑬ 待验收卡和「审查通过」通知读同一份视图：视图读的时候还在审、之后才落了通过 → 这一次两边都不出，
//    下一次对账只出待验收卡，不会一次通过响两遍。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-im-review-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-im-review");

let failure: unknown = null;
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { freeReviewRuns, freeWorkflowStates } = await import("../src/db/schema-free-workflow.js");
  const { imBindings, imOutbox } = await import("../src/db/schema-im.js");
  const { eq } = await import("drizzle-orm");
  const { APP, OWNER, FakeFeishu, buildApp, assemble, buttonsOf, contentOf, textOf } = await import("./im-fixture.js");

  await ensureSchema();
  const { writeMeta } = await import("../src/im/meta.js");
  const since = "2026-11-10T08:05:00.000Z";
  await writeMeta("review-outcomes-since", since);
  const fake = new FakeFeishu();
  const im = await assemble(buildApp(), fake);
  const t0 = "2026-11-10T08:00:00.000Z";
  const t1 = "2026-11-10T08:10:00.000Z";
  const t2 = "2026-11-10T08:20:00.000Z";
  mkdirSync(join(stage, "repo"), { recursive: true });
  await db.insert(projects).values({ id: "p1", name: "飞书项目", repoPath: join(stage, "repo"), apiKeys: null, createdAt: t0 } as never);
  await db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: OWNER, userId: null, boundAt: t0 });
  const task = (over: Record<string, unknown>) => ({
    projectId: "p1", body: "", workflowMode: "free", status: "done", endedAt: t0, createdAt: t0, updatedAt: t0, ...over,
  });
  const run = (over: Record<string, unknown>) => ({
    reviewerId: null, reviewerName: "审查者", agentType: "claude", checkMode: "logic", retryLimit: 1, currentRound: 1,
    targetKind: "workspace", createdAt: t0, updatedAt: t0, finishedAt: null, ...over,
  });
  const reserve = (taskId: string, runId: string | null = null) => db.insert(freeWorkflowStates)
    .values({ taskId, reviewArmed: true, reviewRunId: runId, updatedAt: t0 } as never)
    .onConflictDoUpdate({ target: freeWorkflowStates.taskId, set: { reviewArmed: true, reviewRunId: runId } as never });
  const rowsOf = (taskId: string) => db.select().from(imOutbox).where(eq(imOutbox.taskId, taskId));
  const reconcile = async (taskId: string) => {
    await im.reconciler.reconcile([taskId]);
    await im.settle();
  };
  /** 每一段之前都 reset 过：最后发出去的那一条就是这一段推的卡。 */
  const lastCard = () => contentOf(fake.sends().at(-1)!);

  // ── ① 预约着审查：不推 ─────────────────────────────────────────────────
  await db.insert(tasks).values(task({ id: "ta", title: "跑着时预约了审查" }) as never);
  await reserve("ta");
  await reconcile("ta");
  assert.equal((await rowsOf("ta")).length, 0, "审查马上就开：不推「完成了」");

  // ── ② 正在审：不推 ─────────────────────────────────────────────────────
  await db.insert(tasks).values(task({ id: "tb", title: "正在审" }) as never);
  await db.insert(freeReviewRuns).values(run({ id: "rb", taskId: "tb", status: "reviewing" }) as never);
  await reconcile("tb");
  assert.equal((await rowsOf("tb")).length, 0, "审查还没出结论：不推");

  // ── ③ 推出去之后才开审：撤回 ───────────────────────────────────────────
  await db.insert(tasks).values(task({ id: "tc", title: "推了才派审" }) as never);
  await reconcile("tc");
  const tcRow = (await rowsOf("tc"))[0]!;
  assert.equal(tcRow.kind, "accept");
  assert.ok(tcRow.messageId, "没审查时照常推「完成了」");
  fake.reset();
  await db.insert(freeReviewRuns).values(run({ id: "rc", taskId: "tc", status: "reviewing", createdAt: t1 }) as never);
  await reconcile("tc");
  assert.equal(fake.recalls().filter((call) => call.path.endsWith(`/messages/${tcRow.messageId}`)).length, 1, "开审了：撤回「完成了」");
  const tcAfter = (await rowsOf("tc"))[0]!;
  assert.equal(tcAfter.patchState, "recalled");
  assert.match(tcAfter.resolution ?? "", /等审查出了结论/);

  // ── ④ 审查通过：推「审查通过」 ─────────────────────────────────────────
  fake.reset();
  await db.update(freeReviewRuns).set({ status: "passed", finishedAt: t1 } as never).where(eq(freeReviewRuns.id, "rc"));
  // 审查回合自己也刷新 endedAt，结算在它之后落 finishedAt。
  await db.update(tasks).set({ endedAt: "2026-11-10T08:09:59.990Z" } as never).where(eq(tasks.id, "tc"));
  await reconcile("tc");
  const passed = (await rowsOf("tc")).filter((row) => row.state !== "resolved");
  assert.equal(passed.length, 1, "通过了：推一张新的");
  const passedText = textOf(lastCard());
  assert.match(passedText, /审查通过，等你验收/);
  assert.doesNotMatch(passedText, /完成了，等你验收/, "不再另说一遍「完成了」");
  const passedHeader = lastCard().header;
  assert.match(passedHeader.title.content, /^【飞书项目】/, "卡片标题最前面是项目名");
  assert.equal(passedHeader.subtitle?.content, "审查通过，等你验收", "项目名不在副标题里再说一遍");

  // ── ⑤ 通过之后又跑了一轮：那次通过不算这一版的 ───────────────────────────
  fake.reset();
  await db.update(tasks).set({ endedAt: t2 } as never).where(eq(tasks.id, "tc"));
  await reconcile("tc");
  const rerun = (await rowsOf("tc")).filter((row) => row.state !== "resolved");
  assert.equal(rerun.length, 1);
  assert.notEqual(rerun[0]!.id, passed[0]!.id, "成果换了一版：新卡");
  assert.match(textOf(lastCard()), /完成了，等你验收/, "新一版没审过：照实说完成了");

  // ── ⑥ 用完轮数没通过：推，等他决定 ─────────────────────────────────────
  await db.insert(tasks).values(task({ id: "td", title: "审查没通过" }) as never);
  await db.insert(freeReviewRuns).values(run({ id: "rd", taskId: "td", status: "stopped", finishedAt: t1 }) as never);
  fake.reset();
  await reconcile("td");
  const td = await rowsOf("td");
  assert.equal(td.length, 1, "审查链停了、没有下一轮：轮到他决定");
  const tdCard = lastCard();
  assert.match(textOf(tdCard), /审查没通过，等你决定/);
  assert.ok(buttonsOf(tdCard).find((button) => button.text === "验收通过")?.confirm, "照样验收要二次确认");

  // ── ⑦ 修完等自动复审（停着的链 + 续轮预约）：不推 ────────────────────────
  await db.insert(tasks).values(task({ id: "te", title: "修完等复审" }) as never);
  await db.insert(freeReviewRuns).values(run({ id: "re", taskId: "te", status: "stopped", finishedAt: t1 }) as never);
  await reserve("te", "re");
  await reconcile("te");
  assert.equal((await rowsOf("te")).length, 0, "下一轮马上就审：不推");

  const noticesOf = async (taskId: string) => (await rowsOf(taskId)).filter((row) => row.kind === "notice");

  // ── ⑧ 卡上已经说了：不另发 ─────────────────────────────────────────────
  assert.equal((await noticesOf("tc")).length, 0, "待验收卡写着「审查通过」：不另发通知");

  // ── ⑨ 失败、取消着的任务审查通过：单独一条 ─────────────────────────────
  for (const [id, status] of [["tf", "failed"], ["tg", "canceled"]] as const) {
    await db.insert(tasks).values(task({ id, title: `${status} 了再派审`, status }) as never);
    await reconcile(id);
    await db.insert(freeReviewRuns).values(run({ id: `r${id}`, taskId: id, status: "reviewing", createdAt: t1 }) as never);
    await db.update(tasks).set({ status: "running" } as never).where(eq(tasks.id, id));
    await reconcile(id);
    await db.update(freeReviewRuns).set({ status: "passed", finishedAt: t1 } as never).where(eq(freeReviewRuns.id, `r${id}`));
    await reconcile(id);
    assert.equal((await noticesOf(id)).length, 0, `${status}：审查回合还没落回原状态，先不发`);
    await db.update(tasks).set({ status, endedAt: "2026-11-10T08:09:59.990Z" } as never).where(eq(tasks.id, id));
    await reconcile(id);
    await reconcile(id);
    const notices = await noticesOf(id);
    assert.equal(notices.length, 1, `${status}：审查通过单独发一条，重复对账不重发`);
    assert.match(JSON.parse(notices[0]!.content).text, /^【飞书项目】审查通过：/);
    assert.ok(notices[0]!.messageId, "发出去了");
  }

  // ── ⑩ 没通过之后又跑了一轮：不说这一版没通过 ───────────────────────────
  fake.reset();
  await db.update(tasks).set({ endedAt: t2 } as never).where(eq(tasks.id, "td"));
  await reconcile("td");
  const tdNew = lastCard();
  assert.match(textOf(tdNew), /完成了，等你验收/);
  assert.doesNotMatch(textOf(tdNew), /审查没通过，等你决定/);
  assert.match(textOf(tdNew), /之后的改动还没复审/);
  assert.ok(buttonsOf(tdNew).find((button) => button.text === "验收通过")?.confirm, "最近一轮没通过：验收照样二次确认");

  // ── ⑪ 启用之前的通过：不补推 ───────────────────────────────────────────
  const { imOutcomes } = await import("../src/db/schema-im.js");
  await db.insert(tasks).values(task({ id: "th", title: "早就审过", status: "failed" }) as never);
  await db.insert(freeReviewRuns).values(run({ id: "rh", taskId: "th", status: "passed", finishedAt: "2026-11-10T08:01:00.000Z" }) as never);
  await db.insert(imOutcomes).values({ appId: APP, taskId: "th", kind: "gate", value: "-", updatedAt: t0 } as never);
  await reconcile("th");
  assert.equal((await noticesOf("th")).length, 0, `通过落在 ${since} 之前：只记不发`);
  assert.equal((await db.select().from(imOutcomes).where(eq(imOutcomes.taskId, "th"))).find((row) => row.kind === "review")?.value, "rh:passed");

  // ── ⑫ 升级时正在审、启动后才通过：照样推 ──────────────────────────────────
  // 账上有没有别的行都一样；取消着的任务不在全量对账的常规候选里，通过那一下的事件丢了也要由全量对账补上。
  for (const [id, status, oldLedger, via] of [
    ["ti", "canceled", true, "event"], ["tj", "canceled", false, "event"],
    ["tl", "paused", false, "event"], ["tm", "canceled", false, "full"],
  ] as const) {
    await db.insert(tasks).values(task({ id, title: `升级时正在审 ${id}`, status: "running", followUpFrom: status }) as never);
    await db.insert(freeReviewRuns).values(run({ id: `r${id}`, taskId: id, status: "reviewing", createdAt: t1 }) as never);
    if (oldLedger) await db.insert(imOutcomes).values({ appId: APP, taskId: id, kind: "gate", value: "-", updatedAt: t0 } as never);
    await im.reconciler.full();
    await im.settle();
    await db.update(freeReviewRuns).set({ status: "passed", finishedAt: t1 } as never).where(eq(freeReviewRuns.id, `r${id}`));
    await db.update(tasks).set({ status, followUpFrom: null, endedAt: "2026-11-10T08:09:59.990Z" } as never).where(eq(tasks.id, id));
    if (via === "full") await im.reconciler.full();
    else await im.reconciler.reconcile([id]);
    await im.settle();
    const label = `${id}（${status}、${oldLedger ? "有旧账" : "账上一行都没有"}、${via}）`;
    assert.equal((await noticesOf(id)).length, 1, `${label}：启动后才落的通过照样推一条`);
    await reconcile(id);
    const notices = await noticesOf(id);
    assert.equal(notices.length, 1, `${label}：重复对账不重发`);
    assert.match(JSON.parse(notices[0]!.content).text, /^【飞书项目】审查通过：/);
  }

  // ── ⑬ 卡和通知读同一份视图 ─────────────────────────────────────────────
  const { viewOf } = await import("../src/im/attention.js");
  const { outcomesOf } = await import("../src/im/outcomes.js");
  await db.insert(tasks).values(task({ id: "tk", title: "结算正落在两次读之间" }) as never);
  await db.insert(freeReviewRuns).values(run({ id: "rk", taskId: "tk", status: "reviewing", createdAt: t1 }) as never);
  await reconcile("tk");
  const before = await viewOf("tk");
  assert.ok(before && before.review.pending && !before.turn, "视图读的时候还在审");
  await db.update(freeReviewRuns).set({ status: "passed", finishedAt: t1 } as never).where(eq(freeReviewRuns.id, "rk"));
  await db.update(tasks).set({ endedAt: "2026-11-10T08:09:59.990Z" } as never).where(eq(tasks.id, "tk"));
  assert.equal((await outcomesOf(before)).find((outcome) => outcome.kind === "review")?.value, "-",
    "结局按视图里的那一份算，不另去库里读一份更新的");
  fake.reset();
  await reconcile("tk");
  await reconcile("tk");
  assert.equal((await noticesOf("tk")).length, 0, "这一刻的下一步是待验收卡：由卡来说");
  assert.equal(fake.sends().length, 1, "一次通过只响一次");
  assert.match(textOf(lastCard()), /审查通过，等你验收/);

  im.reconciler.stop();
  im.sender.stop();
  console.log("test-im-review: ok");
} catch (error) {
  failure = error;
} finally {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
