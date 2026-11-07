// duet 收敛闸口的版本号回归:旧卡片上的点击不能放行新的一扇门,也不能把已经结束的讨论拉起来。
//
// 钉住的几种情况(理由见 server/src/duet/gate-version.ts 与 gate-route.ts 的文件头):
// ① 内存里的门:版本对不上回 stale、门继续等;对上才放行;不带版本保持旧行为;
// ② 版本号开门前在库里领(tasks.duet_gate_version):加列之前的老讨论拿 transcript 里数出来的垫底
//    (没有 version、事件名还是 debate.gate 的按开门序号补);开门行没写进文件(recordGateEvent 只是尽力写)
//    再加上重启,也不会发出重复的版本(审查第 3 轮复现);垫底要读的 transcript 读不了、任务不在库里,领号失败;
// ③ 重启补救那一路:版本不符回 409 stale,而且是在占回合锁之前就回 —— 锁不会泄漏;
//    版本相符照常续上,关门那一行带着被关那扇门的版本;
// ④ 讨论已经 done:带版本的注入/放行一律 409 stale,不走验收打回;
// ⑤ 请求体:expectedVersion 不是正整数、kind 认不出、注入/提问是空的,一律 400;
// ⑥ currentGateVersion(给飞书判断「此刻开着第几版」):内存里的门 > 重启后的门 > null;
// ⑦ shownAtGate(飞书卡片按卡上的版本取正文):库里那份和版本同一条语句写,开门行没写进文件也取得到;
//    取的是**这一扇**的,不拿最近一次开门的顶上;老讨论按开门序号认;下一扇门领号时不带方案就清空。
//
// 一个执行器都不起:ASH_RUNS_DIR 指向临时目录(executors/spawn.ts 的 guardAgentSpawn 据此
// 拦住一切 spawn),走到的动作只有「放行」,它在 resumeAtGate 里只结算、不跑讨论者。
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-duet-gate-version-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

let failure: unknown = null;
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { openGateVersion, resolveGate, waitForGate } = await import("../src/duet/gates.js");
  const { currentGateVersion, lastOpenedGateVersion, nextGateVersion, shownAtGate } = await import("../src/duet/gate-version.js");
  const { gateActionOf, mountDuetGateRoutes } = await import("../src/duet/gate-route.js");
  const { recordGateEvent } = await import("../src/duet/timeline.js");
  const { claimOwnTurn, isTurnClaimed, releaseTurn } = await import("../src/runs.js");

  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "duet gate version", repoPath: root, apiKeys: null, createdAt: at });
  const duetTask = (id: string, status: "awaiting_review" | "done" | "running") => db.insert(tasks).values({
    id, projectId: "p", groupId: null, parentId: null, title: id, body: "", mode: "duet",
    status, labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: null, executorId: null,
    autoTitle: false, duet: JSON.stringify({ topic: "闸口版本", voiceA: "claude", voiceB: "codex", gateG1: "on" }),
    team: null, scheduleId: null, createdAt: at, updatedAt: at,
    useWorktree: false, worktreeBase: null, originTaskId: null,
  });
  const statusOf = async (id: string) => (await db.select({ s: tasks.status }).from(tasks).where(eq(tasks.id, id))).at(0)?.s;
  const transcript = (id: string) => join(root, "runs", id, "transcript.jsonl");
  const writeTranscript = (id: string, rows: (object | string)[]) => {
    mkdirSync(join(root, "runs", id), { recursive: true });
    writeFileSync(transcript(id), rows.map((r) => typeof r === "string" ? r : JSON.stringify(r)).join("\n") + "\n");
  };

  const api = new Hono();
  mountDuetGateRoutes(api);
  const post = async (id: string, body: unknown) => {
    const response = await api.request(`/tasks/${id}/gate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  // ── ① 内存里的门 ──────────────────────────────────────────────────────────
  const live = waitForGate("live", 3);
  assert.equal(openGateVersion("live"), 3);
  assert.deepEqual(resolveGate("live", { kind: "approve" }, 2), { ok: false, reason: "stale", current: 3 },
    "旧版本的点击要被认出来");
  assert.equal(openGateVersion("live"), 3, "版本对不上时门必须继续等,不能被旧卡关掉");
  assert.deepEqual(resolveGate("live", { kind: "approve" }, 3), { ok: true, version: 3 });
  assert.deepEqual(await live, { kind: "approve" });
  assert.equal(openGateVersion("live"), null, "放行之后门就没了");
  assert.deepEqual(resolveGate("live", { kind: "approve" }, 3), { ok: false, reason: "none" });
  const legacyClient = waitForGate("live-old-client", 1);
  assert.deepEqual(resolveGate("live-old-client", { kind: "reject" }), { ok: true, version: 1 }, "不带版本 = 旧行为,照常放行");
  assert.deepEqual(await legacyClient, { kind: "reject" });

  // 同一件事走路由:stale 回 409 并告诉对方现在是第几版,门还在;对上版本才交给讨论。
  const routed = waitForGate("route-live", 2);
  const stale = await post("route-live", { kind: "approve", expectedVersion: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.gateVersion, 2, "回执里带上当前版本,调用方据此刷新卡片");
  assert.equal(openGateVersion("route-live"), 2, "路由回 stale 时门也不能被关掉");
  const accepted = await post("route-live", { kind: "inject", text: "  补一句风险  ", attachments: [], expectedVersion: 2 });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, { ok: true, gateVersion: 2 });
  assert.deepEqual(await routed, { kind: "inject", text: "  补一句风险  " }, "只传认得的字段,空附件不往下带");
  const routedOld = waitForGate("route-old-client", 7);
  const oldClient = await post("route-old-client", { kind: "approve", text: "老客户端带的备注", side: "A" });
  assert.deepEqual(oldClient.body, { ok: true, gateVersion: 7 }, "不带版本的老客户端照常放行");
  assert.deepEqual(await routedOld, { kind: "approve" }, "approve 上的 text/side 服务端本来就不读,不往下传");

  // ── ② 版本号在库里领 ─────────────────────────────────────────────────────
  await duetTask("legacy", "running");
  writeTranscript("legacy", [
    { round: 1, speaker: "A", text: "我的观点" },
    // 正文里出现闸口事件的字样也不能被当成一次开门。
    { round: 1, speaker: "B", text: '{"type":"duet.gate","open":true}' },
    { type: "debate.gate", taskId: "legacy", gate: "G1", open: true, consensus: true },
    { type: "debate.gate", taskId: "legacy", gate: "G1", open: false },
    "{\"type\":\"duet.gate\",\"open\":tr", // 半截写入的坏行
    { type: "duet.gate", taskId: "legacy", gate: "G1", open: true },
    { type: "duet.gate", taskId: "legacy", gate: "G1", open: false },
  ]);
  assert.equal(await lastOpenedGateVersion("legacy"), 2, "老记录(debate.gate、没有 version)按开门序号补");
  assert.equal(await nextGateVersion("legacy"), 3, "新开的门接着老记录往下数");
  assert.equal(await nextGateVersion("legacy"), 4, "上一扇门没写进文件也不能重发同一个版本");
  assert.equal(await lastOpenedGateVersion("legacy"), 4, "领过号之后认库里的");
  appendFileSync(transcript("legacy"), JSON.stringify({ type: "duet.gate", taskId: "legacy", gate: "G1", open: true, version: 9 }) + "\n");
  assert.equal(await nextGateVersion("legacy"), 5, "领过号之后 transcript 只是历史,不再左右发号");
  await duetTask("legacy-versioned", "running");
  writeTranscript("legacy-versioned", [{ type: "duet.gate", taskId: "legacy-versioned", gate: "G1", open: true, version: 9 }]);
  assert.equal(await lastOpenedGateVersion("legacy-versioned"), 9, "老讨论的行上带了 version 就用它");
  assert.equal(await nextGateVersion("legacy-versioned"), 10);
  await duetTask("never-opened", "running");
  assert.equal(await lastOpenedGateVersion("never-opened"), 0, "从没开过门 = 0");
  assert.equal(await nextGateVersion("never-opened"), 1);

  // 审查第 3 轮复现:第 4 扇门的开门行没写进 transcript(磁盘满),server 随后重启 —— 内存里什么都不剩。
  // 重启要换一份全新的模块实例来演(老实现把发过的号记在模块里的 Map 上,同一份实例演不出重启)。
  await duetTask("lost-write", "running");
  for (let i = 1; i <= 3; i++) {
    const v = await nextGateVersion("lost-write");
    recordGateEvent({ type: "duet.gate", taskId: "lost-write", gate: "G1", open: true, version: v });
    recordGateEvent({ type: "duet.gate", taskId: "lost-write", gate: "G1", open: false, version: v });
  }
  assert.equal(await nextGateVersion("lost-write"), 4, "第 4 扇门领到号;开门行故意不写");
  const restarted: typeof import("../src/duet/gate-version.js") = await import("../src/duet/gate-version.js?restarted");
  await db.update(tasks).set({ status: "awaiting_review" }).where(eq(tasks.id, "lost-write"));
  assert.equal(await restarted.currentGateVersion("lost-write"), 4, "重启后停在闸口:开着的是第 4 扇,不是文件里最后那扇");
  const lostStale = await post("lost-write", { kind: "approve", expectedVersion: 3 });
  assert.equal(lostStale.status, 409, "第 3 张卡不能借重启补救放行第 4 扇门");
  assert.equal(lostStale.body.gateVersion, 4);
  assert.equal(isTurnClaimed("lost-write"), false);
  await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, "lost-write"));
  const fifth = await restarted.nextGateVersion("lost-write");
  assert.equal(fifth, 5, "重启之后的下一扇门不能再发 4");
  const fifthGate = waitForGate("lost-write", fifth);
  const oldCard = await post("lost-write", { kind: "approve", expectedVersion: 4 });
  assert.equal(oldCard.status, 409, "第 4 张卡上的放行点不中第 5 扇门");
  assert.equal(oldCard.body.stale, true);
  assert.equal(openGateVersion("lost-write"), 5, "门继续等");
  resolveGate("lost-write", { kind: "reject" }, 5);
  await fifthGate;

  // 领不到号就抛:垫底要读的 transcript 读不了(这里是个目录)、任务不在库里 —— 不拿时钟或 0 凑一个号。
  await duetTask("unreadable", "running");
  mkdirSync(transcript("unreadable"), { recursive: true });
  await assert.rejects(nextGateVersion("unreadable"), /EISDIR/, "读不了老记录就不发号");
  await assert.rejects(lastOpenedGateVersion("unreadable"), /EISDIR/);
  assert.equal((await db.select({ v: tasks.duetGateVersion }).from(tasks).where(eq(tasks.id, "unreadable"))).at(0)?.v, null,
    "领号失败什么都不落");
  await assert.rejects(nextGateVersion("no-such-task"), /不在库里/);

  // ── ③ 重启补救那一路 ──────────────────────────────────────────────────────
  // 用真的写入口落两扇门(第 1 扇已关,第 2 扇开着),然后内存里没有门 = server 重启过。
  await duetTask("restart", "awaiting_review");
  const v1 = await nextGateVersion("restart");
  recordGateEvent({ type: "duet.gate", taskId: "restart", gate: "G1", open: true, version: v1 });
  recordGateEvent({ type: "duet.gate", taskId: "restart", gate: "G1", open: false, version: v1 });
  const v2 = await nextGateVersion("restart");
  recordGateEvent({ type: "duet.gate", taskId: "restart", gate: "G1", open: true, version: v2 });
  assert.deepEqual([v1, v2], [1, 2]);
  assert.equal(openGateVersion("restart"), null);
  assert.equal(await currentGateVersion("restart"), 2, "重启后的门:版本取最近一次发出去的号");

  const restartStale = await post("restart", { kind: "approve", expectedVersion: 1 });
  assert.equal(restartStale.status, 409);
  assert.equal(restartStale.body.stale, true);
  assert.equal(restartStale.body.gateVersion, 2);
  assert.equal(isTurnClaimed("restart"), false, "stale 那条出路不能把回合锁留在手里");
  assert.equal(await statusOf("restart"), "awaiting_review", "过时的点击什么都不能改");

  // 版本比对在占锁之前:锁被别人占着时,过时的点击照样认得出是 stale(而不是「回合正在进行」)。
  const held = claimOwnTurn("restart", "duet");
  assert.ok(held);
  assert.equal(await currentGateVersion("restart"), null, "锁被占着而内存里没有门 = 正在开门或回炉的路上,不报版本");
  assert.equal((await post("restart", { kind: "approve", expectedVersion: 1 })).body.stale, true);
  const busy = await post("restart", { kind: "approve", expectedVersion: 2 });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.stale, undefined, "版本对得上、只是回合被占,不是 stale");
  assert.equal(isTurnClaimed("restart"), true, "别人的锁原样还在");
  releaseTurn("restart", held!);

  const resumed = await post("restart", { kind: "approve", expectedVersion: 2 });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.resumed, true);
  for (let i = 0; i < 200 && (isTurnClaimed("restart") || (await statusOf("restart")) === "awaiting_review"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(await statusOf("restart"), "done", "版本对得上的放行照常结束讨论");
  assert.equal(isTurnClaimed("restart"), false);
  const lastLine = JSON.parse(readFileSync(transcript("restart"), "utf8").trim().split("\n").at(-1)!);
  assert.deepEqual(lastLine, { type: "duet.gate", taskId: "restart", gate: "G1", open: false, version: 2 },
    "重启后关门那一行带上被关那扇门的版本,和开门行配成一对");
  assert.equal(await currentGateVersion("restart"), null, "讨论结束后没有能点的门");

  // ── ④ 讨论已经 done:带版本的点击一律 stale,不走验收打回 ──────────────────
  await duetTask("finished", "done");
  writeTranscript("finished", [{ type: "duet.gate", taskId: "finished", gate: "G1", open: true, version: 1 },
    { type: "duet.gate", taskId: "finished", gate: "G1", open: false, version: 1 }]);
  for (const action of [{ kind: "inject", text: "旧卡上的注入" }, { kind: "ask", text: "旧卡上的提问" }, { kind: "approve" }]) {
    const rejected = await post("finished", { ...action, expectedVersion: 1 });
    assert.equal(rejected.status, 409, `${action.kind}:已经结束的讨论不能被旧卡拉起来`);
    assert.equal(rejected.body.stale, true);
    assert.equal(rejected.body.gateVersion, null);
  }
  assert.equal(isTurnClaimed("finished"), false);
  assert.equal(await statusOf("finished"), "done");
  assert.equal(await currentGateVersion("finished"), null);
  assert.equal(await currentGateVersion("no-such-task"), null);

  // ── ⑤ 请求体 ─────────────────────────────────────────────────────────────
  for (const [label, body] of [
    ["坏 JSON", "{not json"],
    ["expectedVersion 是字符串", { kind: "approve", expectedVersion: "x" }],
    ["expectedVersion 是 0", { kind: "approve", expectedVersion: 0 }],
    ["expectedVersion 是小数", { kind: "approve", expectedVersion: 1.5 }],
    ["expectedVersion 是 null", { kind: "approve", expectedVersion: null }],
    ["kind 拼错", { kind: "approv" }],
    ["空的注入", { kind: "inject", text: "   " }],
    ["提问对象认不出", { kind: "ask", text: "问谁?", target: "C" }],
  ] as const) {
    const response = await post("finished", body);
    assert.equal(response.status, 400, `${label} 应当回 400`);
  }
  assert.equal(await statusOf("finished"), "done");
  // 只贴截图不打字也算一次注入(与 gateUserMessage 的兜底句同一个口径)。
  assert.deepEqual(gateActionOf({ kind: "inject", text: "", attachments: ["/tmp/a.png"] }),
    { kind: "inject", text: "", attachments: ["/tmp/a.png"] });
  assert.deepEqual(gateActionOf({ kind: "ask", text: "问 B", target: "B" }), { kind: "ask", text: "问 B", target: "B" });

  // ── ⑥ currentGateVersion:内存里的门优先 ───────────────────────────────────
  const inMemory = waitForGate("restart", 5);
  assert.equal(await currentGateVersion("restart"), 5, "内存里开着的门就是它的版本(不看库里的状态)");
  resolveGate("restart", { kind: "reject" }, 5);
  await inMemory;

  // ── ⑦ shownAtGate:正文认的是哪一扇门 ─────────────────────────────────────
  // 审查复现:第 1 扇门的开门行写的是旧方案,第 2 扇门领了号、开门行没写进文件 —— 卡片拿「最近一次开门」的正文,
  // 摆出来的是旧方案,按钮放行的却是第 2 扇。
  await duetTask("shown", "awaiting_review");
  const oldPlan = { consensus: true, conclusionA: "OLD_PLAN_1", conclusionB: "OLD_PLAN_1" };
  writeTranscript("shown", [{ type: "duet.gate", taskId: "shown", gate: "G1", open: true, version: 1, ...oldPlan }]);
  const newPlan = { consensus: false, consensusBy: "A" as const, conclusionA: "NEW_PLAN_A", conclusionB: "NEW_PLAN_B" };
  assert.equal(await nextGateVersion("shown", newPlan), 2);
  assert.deepEqual(await shownAtGate("shown", 2), newPlan, "开门行没写进文件:库里和版本一起落下的那份照样取得到");
  assert.deepEqual(await shownAtGate("shown", 1), { consensus: true, conclusionA: "OLD_PLAN_1", conclusionB: "OLD_PLAN_1" },
    "库里已经是下一扇了:旧版本到 transcript 里找同版本那一行");
  assert.equal(await shownAtGate("shown", 3), null, "没有这一扇的,不拿别的门顶上");
  assert.equal(await nextGateVersion("shown"), 3, "下一扇门不带方案");
  assert.equal(await shownAtGate("shown", 3), null, "不带方案就清空,不留着上一扇门的");
  assert.deepEqual(await shownAtGate("legacy", 1), { consensus: true, conclusionA: null, conclusionB: null },
    "老讨论(没有 version、debate.gate)按开门序号认");
  await assert.rejects(shownAtGate("unreadable", 1), /EISDIR/, "读不了不当成没有");

  console.log("✓ 闸口版本:旧卡点不中新门、门继续等;不带版本的老客户端照旧");
  console.log("✓ 版本在库里领(老讨论按 transcript 垫底、开门行写丢再重启也不重号、领不到就抛);重启补救 stale 不占锁,对上版本照常续、关门行带版本");
  console.log("✓ 已结束的讨论不被旧卡拉起;请求体非法一律 400;currentGateVersion 三档;卡片正文按版本取、取不到不借");
} catch (error) {
  failure = error;
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
process.exit(0);
